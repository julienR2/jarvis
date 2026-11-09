import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Pause, Play, Repeat, Settings2 } from 'lucide-react'
import { api, type Conversation, type Run } from '../api'
import { useChatStore } from '../stores/chatStore'
import { describeSchedule, relative } from '../lib/runs'
import { routinePath, type Routine } from '../lib/routines'
import { isDraftThread } from '../lib/threads'
import { CreateRow, ListHeading, SubChatRow } from './SubChatRow'

/**
 * The chat's routines, in its # list under its side chats — a routine is a
 * side chat of the whole chat that Jarvis writes in on its own. Each row says
 * when it runs and what it did last time; it opens beside the chat, pauses,
 * and leads to its settings. Fetched when the list opens: most visits to a
 * chat never look. "New routine" opens a side chat with Jarvis to set one up.
 */
export default function ChatRoutines({ conversationId, threads, activeId, onOpenThread, onNavigate }: {
  conversationId: string
  /** The threads the chat's routines run in, as far as they have run. */
  threads: Conversation[]
  activeId: string | null
  onOpenThread: (id: string) => void
  /** Called before leaving for another page, so the list can close. */
  onNavigate: () => void
}) {
  const navigate = useNavigate()
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  // Each routine's last run. They are filed under the routine's own thread,
  // not this chat, so the chat's runs don't have them.
  const [starting, setStarting] = useState(false)
  const [lastRuns, setLastRuns] = useState<Record<string, Run | undefined>>({})

  const load = useCallback(async () => {
    try {
      const [crons, hooks] = await Promise.all([api.getCrons(), api.getWebhooks()])
      const mine: Routine[] = [
        ...crons.filter((c) => c.conversation_id === conversationId || c.thread_id === conversationId).map((row): Routine => ({ kind: 'cron', row })),
        ...hooks.filter((h) => h.conversation_id === conversationId || h.thread_id === conversationId).map((row): Routine => ({ kind: 'webhook', row })),
      ]
      mine.sort((a, b) => a.row.name.localeCompare(b.row.name))
      setRoutines(mine)
      const last = await Promise.all(mine.map((r) => api.listRunsAll({ sourceId: r.row.id, limit: 1 }).then((l) => l[0]).catch(() => undefined)))
      setLastRuns(Object.fromEntries(mine.map((r, i) => [r.row.id, last[i]])))
    } catch {
      setRoutines([])
    }
  }, [conversationId])
  useEffect(() => { load() }, [load])

  async function toggle(r: Routine) {
    if (r.kind === 'cron') await api.updateCron(r.row.id, { enabled: !r.row.enabled })
    else await api.updateWebhook(r.row.id, { enabled: !r.row.enabled })
    await load()
    // The sidebar's routine flag comes from the list.
    useChatStore.getState().loadConversations()
  }
  function go(path: string) {
    onNavigate()
    navigate(path)
  }
  async function startNew() {
    setStarting(true)
    try {
      // A routine starts as a side chat with Jarvis: say what you want, it sets it up.
      const thread = await api.startRoutineSetup({ conversationId })
      await useChatStore.getState().loadConversations()
      onNavigate()
      onOpenThread(thread.id)
    } catch (e) {
      window.__jarvisToast?.error((e as Error).message)
    } finally {
      setStarting(false)
    }
  }
  const byId = new Map(threads.map((t) => [t.id, t]))
  // A thread whose routine is gone still holds its runs: listed, without a routine to manage.
  const orphans = routines ? threads.filter((t) => !routines.some((r) => r.row.thread_id === t.id) && !isDraftThread(t)) : []
  // A routine being set up has no routine yet: its side chat is the routine so far.
  const drafts = threads.filter((t) => isDraftThread(t))

  return (
    <div data-testid='chat-routines'>
      <ListHeading>Routines</ListHeading>
      {routines === null ? (
        <div className='flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-text-muted'><Loader2 size={11} className='animate-spin' /> Loading…</div>
      ) : (
        <>
          {routines.map((r) => {
            const thread = r.row.thread_id ? byId.get(r.row.thread_id) : undefined
            const waiting = !!thread?.pending_question
            const last = r.row.id in lastRuns ? lastRuns[r.row.id] : null
            const when = r.kind === 'cron' ? capitalize(describeSchedule(r.row.schedule)) : 'When triggered'
            return (
              <SubChatRow
                key={`${r.kind}-${r.row.id}`}
                testId='chat-routines-row'
                icon={<Repeat size={12} className='text-text-muted' />}
                title={r.row.name}
                tag={r.row.enabled ? undefined : 'Paused'}
                muted={!r.row.enabled}
                selected={!!thread && thread.id === activeId}
                right={waiting ? <span className='rounded-full bg-warning px-1.5 font-medium text-white'>waiting for you</span> : last ? relative(last.ended_at ?? last.started_at) : ''}
                sub={`${when} · ${outcome(last)}`}
                openLabel={thread ? 'Open it beside the chat' : 'Open this routine'}
                onOpen={() => (thread ? (onNavigate(), onOpenThread(thread.id)) : go(routinePath(r)))}
                actions={[
                  r.row.enabled
                    ? { label: `Pause ${r.row.name}`, icon: <Pause size={12} />, run: () => toggle(r) }
                    : { label: `Resume ${r.row.name}`, icon: <Play size={12} />, run: () => toggle(r) },
                  { label: `Settings of ${r.row.name}`, icon: <Settings2 size={12} />, run: () => go(routinePath(r)) },
                ]}
              />
            )
          })}
          {[...drafts, ...orphans].map((t) => (
            <SubChatRow
              key={t.id}
              testId='chat-routines-row'
              icon={<Repeat size={12} className='text-text-muted' />}
              title={t.title}
              tag={isDraftThread(t) ? 'Being set up' : undefined}
              selected={t.id === activeId}
              right={relative(t.updated_at)}
              onOpen={() => { onNavigate(); onOpenThread(t.id) }}
              actions={[]}
            />
          ))}
        </>
      )}
      <CreateRow
        label='New routine'
        hint='Jarvis checks or does something on its own: every morning, when an email arrives…'
        onClick={startNew}
        busy={starting}
      />
    </div>
  )
}

/** How the routine's last run went, in plain words (null: still asking). */
function outcome(last: Run | undefined | null): string {
  if (last === null) return '…'
  if (!last) return 'not run yet'
  return last.status === 'running' ? 'running now'
    : last.status === 'needs_you' ? 'waiting for you'
    : last.status === 'error' ? 'failed last time'
    : last.status === 'stopped' || last.status === 'interrupted' ? 'stopped last time'
    : last.quiet ? 'nothing new last time' : 'had news last time'
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
