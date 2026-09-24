import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CheckCheck } from 'lucide-react'
import ChatInput from '../components/ChatInput'
import { useModelCatalogue } from '../components/ModelSelector'
import InboxCard, { type InboxReason } from '../components/InboxCard'
import { SidebarToggle } from '../components/ContentLayout'
import { api, pendingQuestionOf, type Attachment, type Conversation, type Effort, type RunListItem } from '../api'
import { useChatStore } from '../stores/chatStore'
import { BASE_PATH } from '../base'
import { reloadRecentRuns, useRecentRuns } from '../lib/runs'

/**
 * Home — the unreads view.
 *
 * A greeting and the composer first: the assistant is still the point. Under
 * it, every chat with something new, one card each, in the order it matters:
 * chats waiting on you (a question, an approval, a failed run), then chats
 * that were worth a notification, then chats with plain unread answers —
 * newest first within each. A card shows what is new drawn like the chat and
 * the chat's own composer; it leaves when you mark it read, open it, or answer.
 * Collapsing one is "later": it stays, and stays unread.
 *
 * A quiet day is the greeting, the composer and "all caught up".
 *
 * It is also where a new chat starts: "New chat" opens this page with the
 * composer focused, and the chat only exists once something is sent.
 */
export default function TodayPage() {
  const navigate = useNavigate()
  // Set by "New chat" — a fresh token each press, so the focus happens again.
  const navState = useLocation().state as { compose?: number; draft?: string } | null
  const composeKey = navState?.compose
  // A request started elsewhere ("Edit in chat" on a skill) lands in the composer.
  const draft = navState?.draft
  const conversations = useChatStore((s) => s.conversations)
  const sections = useChatStore((s) => s.sections)
  // Since yesterday: a failure from last night still waits, a run started late
  // is still running.
  const { runs, error: loadError } = useRecentRuns()
  const [starting, setStarting] = useState(false)
  // The new chat's first message runs on what's picked here.
  const catalogueDefault = useModelCatalogue().default
  const [picked, setPicked] = useState<string | null>(null)
  const [effort, setEffort] = useState<Effort>('default')
  const model = picked ?? catalogueDefault

  const entries = useMemo(() => buildInbox(Object.values(conversations), runs ?? []), [conversations, runs])
  const sectionName = (id: string | null) => (id ? sections.find((s) => s.id === id)?.name : undefined)

  // The composer opens a fresh chat with what was typed: the conversation is
  // created, the message sent, and the chat opened to watch the answer come.
  async function start(text: string, attachments: Attachment[]) {
    if (starting) return
    setStarting(true)
    try {
      const conv = await useChatStore.getState().createConversation()
      await api.sendMessage(conv.id, text, attachments, model, effort)
      navigate(`/c/${conv.id}`)
    } catch (err) {
      console.error('Could not start the chat:', err)
      window.__jarvisToast?.error("Couldn't start the chat — try again.")
      setStarting(false)
    }
  }
  async function startWithAudio(blob: Blob) {
    if (starting) return
    setStarting(true)
    try {
      const conv = await useChatStore.getState().createConversation()
      await api.sendAudio(conv.id, blob, model, effort)
      navigate(`/c/${conv.id}`)
    } catch (err) {
      console.error('Could not start the chat:', err)
      window.__jarvisToast?.error("Couldn't start the chat — try again.")
      setStarting(false)
    }
  }

  async function retry(run: RunListItem) {
    await api.retryRun(run.id)
    await reloadRecentRuns()
  }
  async function stop(run: RunListItem) {
    await api.stopRun(run.id)
    await reloadRecentRuns()
  }
  // ✓ on a card: the chat is read. A failure is put away too — it has no
  // unread to clear, so the run's own flag is what removes it.
  async function markRead(entry: InboxEntry) {
    useChatStore.getState().markRead(entry.conv.id)
    if (entry.failed) {
      await api.dismissRun(entry.failed.run.id).catch(() => {})
      await reloadRecentRuns()
    }
  }

  const dateLine = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
  const counts = {
    action: entries.filter((e) => e.reason === 'action').length,
    notified: entries.filter((e) => e.reason === 'notified').length,
    unread: entries.filter((e) => e.reason === 'unread').length,
  }
  const summary = [
    counts.action && `${counts.action} need${counts.action === 1 ? 's' : ''} you`,
    counts.notified && `${counts.notified} worth a look`,
    counts.unread && `${counts.unread} unread`,
  ].filter(Boolean).join(' · ')
  // What waits on you is never swept by "mark all": an answer or a decision
  // is still owed there.
  const readable = entries.filter((e) => e.reason !== 'action')
  function markAllRead() {
    for (const e of readable) useChatStore.getState().markRead(e.conv.id)
  }

  return (
    <div className='flex flex-col h-full'>
      <div className='shrink-0 border-b border-border'>
        <div className='flex items-center gap-2 h-12 px-3 md:px-6'>
          <SidebarToggle />
          <h1 className='text-sm font-medium text-text-primary'>Today</h1>
        </div>
      </div>

      <div className='flex-1 overflow-y-auto'>
        {/* The landing: Jarvis and the composer on a faint warm glow. What is
            new follows after a separator, the same gap above it and below. */}
        <section
          className='flex flex-col items-center px-4 pt-[12vh] pb-12'
          style={{ background: 'radial-gradient(ellipse 60% 55% at 50% 42%, var(--color-accent-subtle), transparent 70%)' }}
        >
          <img
            src={`${BASE_PATH}/images/jarvis_wave.gif`}
            alt='Jarvis'
            className='h-28 w-28 mix-blend-multiply dark:mix-blend-screen'
          />
          <h2 className='mt-3 text-3xl font-light text-text-primary'>{getGreeting()}</h2>
          {/* The composer already asks how to help; the line under the greeting
              says what day it is instead of saying that twice. */}
          <p className='mt-1.5 text-sm text-text-muted'>{dateLine}</p>
          {/* Same box as the inbox below (max-w-2xl, md:px-6), so the composer
              and the cards line up edge to edge. */}
          <div className='mt-8 w-full max-w-2xl md:px-6'>
            <ChatInput
              onSend={start}
              onSendAudio={startWithAudio}
              onCancel={() => {}}
              isProcessing={false}
              focusKey={composeKey}
              initialText={draft}
              compact
              model={model}
              effort={effort}
              onModelChange={setPicked}
              onEffortChange={setEffort}
            />
          </div>
        </section>

        <div className='max-w-2xl mx-auto px-4 md:px-6 pb-10'>
          {/* A quiet break between the welcome and what is new — there
              whether the inbox is full or caught up. */}
          <div className='mb-12 flex justify-center gap-1.5' aria-hidden='true' data-testid='today-separator'>
            <span className='h-1 w-1 rounded-full bg-text-muted/40' />
            <span className='h-1 w-1 rounded-full bg-text-muted/40' />
            <span className='h-1 w-1 rounded-full bg-text-muted/40' />
          </div>
          {loadError && runs === null && (
            <div className='py-6 text-center text-sm text-text-muted'>
              Couldn't load today's inbox. <button onClick={() => reloadRecentRuns()} className='underline hover:text-text-primary'>Try again</button>
            </div>
          )}

          {entries.length > 0 ? (
            <>
              <div className='mb-2 flex items-center gap-2'>
                <h3 className='shrink-0 text-xs font-medium uppercase tracking-wide text-text-muted'>New</h3>
                <span className='min-w-0 truncate text-xs text-text-muted' data-testid='today-summary'>{summary}</span>
                {readable.length > 1 && (
                  <button
                    onClick={markAllRead}
                    className='ml-auto shrink-0 inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-xs text-text-muted hover:bg-surface2 hover:text-text-primary transition-colors'
                    title='Mark every chat here read, except what waits on you'
                    aria-label='Mark all read'
                  >
                    <CheckCheck size={13} /> <span className='hidden sm:inline'>Mark all read</span>
                  </button>
                )}
              </div>
              <div className='flex flex-col gap-3' data-testid='today-inbox'>
                {entries.map((e) => (
                  <InboxCard
                    key={e.conv.id}
                    conversation={e.conv}
                    runs={e.runs}
                    failed={e.failed}
                    reason={e.reason}
                    sectionName={sectionName(e.conv.section_id)}
                    onOpen={() => navigate(`/c/${e.conv.id}`)}
                    onRead={() => markRead(e)}
                    onRetry={retry}
                    onStop={stop}
                  />
                ))}
              </div>
            </>
          ) : runs !== null && (
            <div className='flex flex-col items-center gap-1.5 text-center text-sm text-text-muted' data-testid='today-empty'>
              <CheckCheck size={18} className='opacity-60' />
              All caught up.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return 'Good night'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

interface InboxEntry {
  conv: Conversation
  reason: InboxReason
  runs: RunListItem[]
  failed?: { run: RunListItem; attempts: number }
  /** When its newest news landed — the order within a group. */
  at: number
}

const RANK: Record<InboxReason, number> = { action: 0, notified: 1, unread: 2 }

/**
 * Which chats have something new, and in what order. A chat waits on you when
 * Jarvis asked a question or wants an approval, or when one of its routines
 * failed and nothing has succeeded since (repeats of the same routine count as
 * attempts; a put-away failure no longer counts). It was worth a notification
 * when a push went out after it was last read. Otherwise it merely has unread
 * answers. No visible sections — the order carries the meaning.
 */
function buildInbox(conversations: Conversation[], runs: RunListItem[]): InboxEntry[] {
  const byConv = new Map<string, RunListItem[]>()
  for (const r of runs) {
    const list = byConv.get(r.conversation_id) ?? []
    list.push(r)
    byConv.set(r.conversation_id, list)
  }

  const failedByConv = new Map<string, { run: RunListItem; attempts: number }>()
  const seen = new Set<string>()
  for (const run of runs) {
    if (run.status !== 'error' || run.dismissed) continue
    const key = run.source_id ?? run.id
    if (seen.has(key)) continue
    seen.add(key)
    const later = runs.some((r) => r.source_id && r.source_id === run.source_id && r.status === 'done' && r.started_at > run.started_at)
    if (later) continue
    const attempts = runs.filter((r) => r.status === 'error' && (r.source_id ?? r.id) === key).length
    if (!failedByConv.has(run.conversation_id)) failedByConv.set(run.conversation_id, { run, attempts })
  }

  const entries: InboxEntry[] = []
  for (const conv of conversations) {
    const convRuns = byConv.get(conv.id) ?? []
    const pending = pendingQuestionOf(conv)
    const failed = failedByConv.get(conv.id)
    const waiting = convRuns.some((r) => r.status === 'needs_you')
    const unread = (conv.unread_count ?? 0) > 0
    const notified = unread && (conv.notified_at ?? 0) > (conv.last_read_at ?? 0)
    const reason: InboxReason | null =
      pending || failed || waiting ? 'action' : notified ? 'notified' : unread ? 'unread' : null
    if (!reason) continue
    entries.push({
      conv,
      reason,
      runs: convRuns,
      failed,
      at: Math.max(conv.updated_at, failed?.run.started_at ?? 0),
    })
  }
  return entries.sort((a, b) => RANK[a.reason] - RANK[b.reason] || b.at - a.at)
}
