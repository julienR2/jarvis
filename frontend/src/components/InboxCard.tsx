import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, RotateCcw, Square } from 'lucide-react'
import {
  api,
  pendingQuestionOf,
  questionsOf,
  type Conversation,
  type Message,
  type RunListItem,
} from '../api'
import AnswerCard, { answerFromComposer } from './AnswerCard'
import ChatInput from './ChatInput'
import MessageBubble from './MessageBubble'
import RunBlock from './RunBlock'
import { useChatStore } from '../stores/chatStore'
import { dropQuietRuns, groupMessagesByDay } from '../lib/transcript'

export type InboxReason = 'action' | 'notified' | 'unread'

/**
 * One chat with something new, on Today — the unreads view of a messenger.
 *
 * The header says which chat and why it is here; open (the default) the card
 * shows what is new in it, drawn with the chat's own components, then the
 * chat's own composer in compact form — a question's options, Approve / Deny
 * for a tool call, or a plain reply box. Reading here marks nothing: the card
 * leaves when you mark it read (✓), open the chat, or answer. Collapsing it is
 * "later": the header stays, the chat stays unread.
 */
export default function InboxCard({
  conversation,
  runs,
  failed,
  reason,
  sectionName,
  onOpen,
  onRead,
  onRetry,
  onStop,
}: {
  conversation: Conversation
  /** This chat's recent runs — provenance for its run blocks, and its state. */
  runs: RunListItem[]
  /** A run that failed and nothing has fixed since. */
  failed?: { run: RunListItem; attempts: number }
  reason: InboxReason
  sectionName?: string
  onOpen: () => void
  onRead: () => void
  onRetry?: (run: RunListItem) => Promise<void>
  onStop?: (run: RunListItem) => Promise<void>
}) {
  const [open, setOpen] = useState(true)
  const [page, setPage] = useState<Message[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  // How many read messages to show above the new ones ("Show earlier").
  const [earlier, setEarlier] = useState(0)
  const [busy, setBusy] = useState(false)

  const pending = pendingQuestionOf(conversation)
  const isQuestion = !!pending && questionsOf(pending).length > 0
  const waitingRun = runs.find((r) => r.status === 'needs_you')
  const runningRun = runs.find((r) => r.status === 'running')
  const readAt = conversation.last_read_at ?? 0

  // The newest page, fetched without marking anything read (the chat's own GET
  // would). Refetched when the chat moves: a new answer, a new question.
  useEffect(() => {
    let alive = true
    api.getMessages(conversation.id, 30)
      .then((p) => { if (alive) { setPage(p.messages); setHasMore(p.has_more) } })
      .catch(() => { if (alive) setPage([]) })
    return () => { alive = false }
  }, [conversation.id, conversation.updated_at, conversation.unread_count, conversation.pending_question])

  const all = page ?? []
  const firstNewIdx = all.findIndex((m) => m.created_at > readAt)
  const newMessages = firstNewIdx >= 0 ? all.slice(firstNewIdx) : []
  const readBefore = firstNewIdx >= 0 ? all.slice(0, firstNewIdx) : all
  const shown = [...readBefore.slice(Math.max(0, readBefore.length - earlier)), ...newMessages]
  const canShowEarlier = earlier < readBefore.length || hasMore

  async function showEarlier() {
    if (earlier < readBefore.length) {
      setEarlier((n) => Math.min(readBefore.length, n + 6))
      return
    }
    if (!hasMore || all.length === 0) return
    const older = await api.getOlderMessages(conversation.id, all[0].seq, 20)
    setPage([...older.messages, ...all])
    setHasMore(older.has_more)
    setEarlier((n) => n + older.messages.length)
  }

  const runsById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs])
  const items = useMemo(() => dropQuietRuns(groupMessagesByDay(shown, null), runsById), [shown, runsById])

  const newCount = conversation.unread_count ?? newMessages.length

  const status = failed ? 'error' : waitingRun || pending ? 'needs_you' : runningRun ? 'running' : reason

  async function answer(text: string, attachments: Parameters<typeof answerFromComposer>[3]) {
    if (pending) await answerFromComposer(conversation.id, pending, text, attachments)
  }
  async function answerAudio(blob: Blob) {
    if (!pending) return
    const { transcript } = await api.transcribeAudio(blob)
    if (transcript.trim()) await answerFromComposer(conversation.id, pending, transcript.trim(), [])
  }
  // A plain reply: sent, and the chat counts as read — the answer coming back
  // brings the card back with it.
  async function reply(text: string, attachments: Parameters<typeof answerFromComposer>[3]) {
    await api.sendMessage(conversation.id, text, attachments.length ? attachments : undefined)
    useChatStore.getState().markRead(conversation.id)
  }
  async function replyAudio(blob: Blob) {
    await api.sendAudio(conversation.id, blob)
    useChatStore.getState().markRead(conversation.id)
  }
  async function act(fn?: (run: RunListItem) => Promise<void>, run?: RunListItem) {
    if (!fn || !run) return
    setBusy(true)
    try { await fn(run) } finally { setBusy(false) }
  }

  return (
    <div
      className='overflow-hidden rounded-xl border border-border bg-surface'
      data-testid='today-row'
      data-status={status}
      data-reason={reason}
    >
      <div className='flex items-center gap-2.5 px-3 py-2'>
        <button onClick={() => setOpen((v) => !v)} className='flex min-w-0 flex-1 items-center gap-2.5 text-left' aria-expanded={open}>
          <span className='shrink-0 text-text-muted'>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
          {/* Just the chat and where it lives — what is new is in the card. */}
          <span className='flex min-w-0 flex-1 items-baseline gap-1.5'>
            <span className='shrink-0 max-w-[70%] truncate text-sm font-medium text-text-primary'>{conversation.title}</span>
            {sectionName && <span className='min-w-0 truncate text-[12px] text-text-muted'>– {sectionName}</span>}
          </span>
        </button>
        <span className='flex shrink-0 items-center gap-1.5'>
          {newCount > 0 && (
            <span className='mr-1 whitespace-nowrap text-[12px] text-text-muted' data-testid='today-row-count'>
              {newCount} message{newCount === 1 ? '' : 's'}
            </span>
          )}
          {failed && onRetry && (
            <button onClick={() => act(onRetry, failed.run)} disabled={busy} className='inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50'>
              {busy ? <Loader2 size={12} className='animate-spin' /> : <RotateCcw size={12} />} Retry
            </button>
          )}
          {runningRun && onStop && (
            <button onClick={() => act(onStop, runningRun)} disabled={busy} className='inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface2 hover:text-text-primary disabled:opacity-50'>
              <Square size={10} fill='currentColor' /> Stop
            </button>
          )}
          <button onClick={onOpen} className='rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface2 hover:text-text-primary'>
            {conversation.app_path ? 'Open app' : 'Open'}
          </button>
          <button onClick={onRead} aria-label={`Mark ${conversation.title} as read`} title='Mark as read' className='rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface2 hover:text-text-primary'>
            <Check size={14} />
          </button>
        </span>
      </div>

      {open && (
        <>
          {/* A failure that wrote nothing into the chat: its error is the news. */}
          {failed && newMessages.length === 0 && (
            <div className='flex items-start gap-1.5 border-t border-border/60 px-3 py-2.5 text-[13px] text-danger' data-testid='inbox-error'>
              <span className='min-w-0 whitespace-pre-wrap'>{failed.run.error ?? 'The run failed.'}</span>
            </div>
          )}

          {/* What is new, drawn as the chat draws it. */}
          {(shown.length > 0 || canShowEarlier) && (
            <div className='border-t border-border/60 px-3 pt-3' data-testid='inbox-messages'>
              {canShowEarlier && (
                <div className='mb-2 flex justify-center'>
                  <button onClick={showEarlier} className='inline-flex items-center gap-1 text-[11.5px] text-text-muted transition-colors hover:text-text-primary'>
                    <ChevronDown size={11} className='rotate-180' /> Show earlier
                  </button>
                </div>
              )}
              {page === null ? (
                <div className='flex justify-center py-3'><Loader2 size={14} className='animate-spin text-text-muted' /></div>
              ) : (
                items.map((item) =>
                  item.type === 'separator' ? (
                    // "Today" goes without saying on Today; older days are worth a label.
                    item.label === 'Today' ? null : (
                      <div key={item.key} className='my-2 text-center text-[10.5px] uppercase tracking-wide text-text-muted/70'>{item.label}</div>
                    )
                  ) : item.type === 'unread' ? null : item.type === 'runBlock' ? (
                    <RunBlock key={item.key} run={runsById.get(item.runId)} msgs={item.msgs} live={false} />
                  ) : (
                    <MessageBubble key={item.msg.id} msg={item.msg} />
                  ),
                )
              )}
            </div>
          )}

          {/* The way to act, in place: the chat's own composer. */}
          <div className='border-t border-border/60 px-3 py-2'>
            {isQuestion ? (
              <ChatInput onSend={answer} onSendAudio={answerAudio} onCancel={() => {}} isProcessing={false} conversationId={conversation.id} question={pending!} compact />
            ) : pending ? (
              <AnswerCard conversationId={conversation.id} question={pending} />
            ) : (
              <ChatInput onSend={reply} onSendAudio={replyAudio} onCancel={() => {}} isProcessing={!!runningRun} conversationId={conversation.id} placeholder='Reply…' compact />
            )}
          </div>
        </>
      )}
    </div>
  )
}
