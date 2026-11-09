import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, Link2, Loader2, Plus, Repeat, Settings2 } from 'lucide-react'
import { api, type Conversation, type Run } from '../api'
import { useChatStore } from '../stores/chatStore'
import { describeSchedule, relative } from '../lib/runs'
import { routinePath, type Routine } from '../lib/routines'

/**
 * The chat's routines, in its # list beside its threads — a routine is a
 * thread of the whole chat rather than of one message. What posts here and
 * when, how the last run went, paused or not. Fetched when the list opens:
 * most visits to a chat never look. A row opens the routine's thread beside
 * the chat; the gear opens the routine itself; everything else lives on the
 * Routines page, filtered to this chat.
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
  const known = new Set(threads.map((t) => t.id))
  // A thread whose routine is gone still holds its runs: listed, without a routine to manage.
  const orphans = routines ? threads.filter((t) => !routines.some((r) => r.row.thread_id === t.id)) : []

  return (
    <div className='mt-1 border-t border-border pt-1' data-testid='chat-routines'>
      <div className='flex items-center justify-between px-2.5 pb-0.5 pt-1'>
        <span className='text-[10.5px] font-semibold uppercase tracking-wide text-text-muted'>Routines</span>
        <button
          onClick={() => go(`/routines/new?kind=cron&conversation_id=${conversationId}`)}
          title='New routine here'
          aria-label='New routine here'
          className='rounded-md p-0.5 text-text-muted hover:bg-surface2 hover:text-text-primary'
        >
          <Plus size={12} />
        </button>
      </div>
      {routines === null ? (
        <div className='flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-text-muted'><Loader2 size={11} className='animate-spin' /> Loading…</div>
      ) : routines.length === 0 && orphans.length === 0 ? (
        <div className='px-2.5 py-1.5 text-[11px] text-text-muted'>None yet — ask Jarvis to check something on a schedule, or press +.</div>
      ) : (
        <>
          {routines.map((r) => {
            const Icon = r.kind === 'webhook' ? Link2 : Clock
            const thread = r.row.thread_id && known.has(r.row.thread_id) ? r.row.thread_id : null
            const when = r.kind === 'cron' ? describeSchedule(r.row.schedule) : 'when called'
            return (
              <div key={`${r.kind}-${r.row.id}`} className={`group flex items-center gap-1 rounded-lg ${thread && thread === activeId ? 'bg-surface2' : 'hover:bg-surface2'}`} data-testid='chat-routines-row'>
                <button
                  onClick={() => (thread ? (onNavigate(), onOpenThread(thread)) : go(routinePath(r)))}
                  title={thread ? 'Open its thread beside the chat' : 'Open this routine'}
                  className={`flex min-w-0 flex-1 items-start gap-2 px-2.5 py-1.5 text-left ${r.row.enabled ? '' : 'opacity-60'}`}
                >
                  <Icon size={12} className='mt-0.5 shrink-0 text-text-muted' />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[12.5px] text-text-primary'>{r.row.name}</span>
                    <span className='block truncate text-[11px] text-text-muted'>{when} · {describeLast(r.row.id in lastRuns ? lastRuns[r.row.id] : null)}</span>
                  </span>
                </button>
                <button
                  onClick={() => go(routinePath(r))}
                  title='Routine settings'
                  aria-label={`Settings of ${r.row.name}`}
                  className='rounded-md p-1 text-text-muted opacity-0 hover:bg-border hover:text-text-primary group-hover:opacity-100 [@media(hover:none)]:opacity-100'
                >
                  <Settings2 size={12} />
                </button>
                <button
                  role='switch'
                  aria-checked={!!r.row.enabled}
                  aria-label={`${r.row.enabled ? 'Pause' : 'Resume'} ${r.row.name}`}
                  onClick={() => toggle(r)}
                  className={`relative mr-2 h-4 w-7 shrink-0 rounded-full transition-colors ${r.row.enabled ? 'bg-success' : 'bg-border'}`}
                >
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${r.row.enabled ? 'left-[14px]' : 'left-0.5'}`} />
                </button>
              </div>
            )
          })}
          {orphans.map((t) => (
            <button key={t.id} onClick={() => { onNavigate(); onOpenThread(t.id) }} className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface2 ${t.id === activeId ? 'bg-surface2' : ''}`}>
              <Repeat size={12} className='mt-0.5 shrink-0 text-text-muted' />
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-[12.5px] text-text-primary'>{t.title}</span>
                <span className='block truncate text-[11px] text-text-muted'>{relative(t.updated_at)}</span>
              </span>
            </button>
          ))}
          <button
            onClick={() => go(`/routines?conversation_id=${conversationId}`)}
            className='w-full rounded-lg px-2.5 py-1.5 text-left text-[11px] text-text-muted hover:bg-surface2 hover:text-text-primary'
          >
            Open in Routines
          </button>
        </>
      )}
    </div>
  )
}

/** "7:00 PM · nothing to report" — how the routine's last run went (null: still asking). */
function describeLast(last: Run | undefined | null): string {
  if (last === null) return '…'
  if (!last) return 'no run yet'
  const when = relative(last.ended_at ?? last.started_at)
  const how = last.status === 'running' ? 'running'
    : last.status === 'needs_you' ? 'waiting for you'
    : last.status === 'error' ? 'failed'
    : last.status === 'stopped' || last.status === 'interrupted' ? 'stopped'
    : last.quiet ? 'nothing to report' : 'reported'
  return `${when} · ${how}`
}
