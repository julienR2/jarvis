import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Clock, Link2, MessageSquare } from 'lucide-react'
import { api, describePending, pendingQuestionOf, questionsOf, type Conversation, type Message, type RunListItem } from '../api'
import AnswerCard, { answerFromComposer } from './AnswerCard'
import ChatInput from './ChatInput'
import StatusPill from './StatusPill'

/**
 * One thing waiting on you, on Today, as a small embedded chat.
 *
 * Collapsed by default — just the header and a one-line hint of what is being
 * asked, so a day's worth of them stays scannable. Open one and it becomes the
 * conversation in miniature: the answer so far (expandable to this exchange),
 * then the very way to answer — the real composer in its compact form for a
 * question, Approve / Deny for a tool call. Answering resolves it without
 * opening the full chat; Open is there when you want the whole thing.
 */
export default function NeedsYouCard({
  conversation,
  run,
  onOpen,
}: {
  conversation: Conversation
  run?: RunListItem
  onOpen: () => void
}) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [showTrail, setShowTrail] = useState(false)
  const pending = pendingQuestionOf(conversation)
  const isQuestion = !!pending && questionsOf(pending).length > 0

  // Only fetch the lead-up once the card is opened — a collapsed day costs
  // nothing.
  useEffect(() => {
    if (!open || messages !== null) return
    let alive = true
    api.getConversation(conversation.id, 20)
      .then((c) => { if (alive) setMessages(c.messages) })
      .catch(() => { if (alive) setMessages([]) })
    return () => { alive = false }
  }, [open, messages, conversation.id])

  const trail = (messages ?? [])
    .map((m) => ({ role: m.role, text: previewText(m) }))
    .filter((m) => m.text)
  // The answer so far is the last thing Jarvis said; the exchange is from your
  // last message down — not the whole history.
  const lastUserIdx = trail.map((m) => m.role).lastIndexOf('user')
  const thisExchange = lastUserIdx >= 0 ? trail.slice(lastUserIdx) : trail
  const shown = showTrail ? thisExchange : trail.slice(-1)
  const moreCount = thisExchange.length - 1

  const Icon = run?.kind === 'webhook' ? Link2 : run?.kind === 'cron' ? Clock : MessageSquare
  const hint = pending ? describePending(pending) : ''

  async function answer(text: string, attachments: Parameters<typeof answerFromComposer>[3]) {
    if (pending) await answerFromComposer(conversation.id, pending, text, attachments)
  }
  async function answerAudio(blob: Blob) {
    if (!pending) return
    const { transcript } = await api.transcribeAudio(blob)
    if (transcript.trim()) await answerFromComposer(conversation.id, pending, transcript.trim(), [])
  }

  return (
    <div
      className='rounded-xl border border-warning/40 bg-surface overflow-hidden'
      data-testid='today-row'
      data-status='needs_you'
    >
      <div className='flex items-center gap-2.5 px-3 py-2.5'>
        <button onClick={() => setOpen((v) => !v)} className='flex min-w-0 flex-1 items-center gap-2.5 text-left' aria-expanded={open}>
          <span className='shrink-0 text-text-muted'>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
          <span className='grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-warning/10 text-warning'><Icon size={13} /></span>
          <span className='min-w-0 flex-1'>
            <span className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='truncate text-sm font-medium text-text-primary'>{run?.source_name ?? conversation.title}</span>
              {run ? <StatusPill run={run} /> : <span className='inline-flex items-center gap-1 rounded-full border border-warning/40 px-1.5 py-px text-[10.5px] font-medium text-warning'>waiting for you</span>}
            </span>
            {/* Collapsed: a one-line hint of what is asked. Open: the composer says it. */}
            {!open && hint && <span className='mt-0.5 block truncate text-[12px] text-text-muted'>{hint}</span>}
          </span>
        </button>
        <button onClick={onOpen} className='shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface2 hover:text-text-primary'>
          {conversation.app_path ? 'Open app' : 'Open'}
        </button>
      </div>

      {open && (
        <>
          {/* The lead-up, chat-shaped. The answer so far by default, the exchange a click away. */}
          {trail.length > 0 && (
            <div className='px-3 pb-2'>
              <div className='rounded-lg bg-bg-alt px-2.5 py-2'>
                <div className='flex flex-col gap-1.5'>
                  {shown.map((m, i) => (
                    <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                      <span className={`inline-block max-w-[85%] rounded-lg px-2 py-1 text-[12px] leading-snug ${m.role === 'user' ? 'bg-accent-subtle text-text-primary' : 'text-text-secondary'} ${showTrail ? '' : 'line-clamp-2'}`}>
                        {m.text}
                      </span>
                    </div>
                  ))}
                </div>
                {moreCount > 0 && (
                  <button onClick={() => setShowTrail((v) => !v)} className='mt-1 inline-flex items-center gap-1 text-[11px] text-text-muted/80 transition-colors hover:text-text-primary'>
                    <ChevronDown size={11} className={`transition-transform ${showTrail ? 'rotate-180' : ''}`} />
                    {showTrail ? 'Hide' : `Show the conversation · ${moreCount} more`}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* The answer, in place. */}
          <div className='border-t border-border/60 px-3 py-2'>
            {isQuestion ? (
              <ChatInput
                onSend={answer}
                onSendAudio={answerAudio}
                onCancel={() => {}}
                isProcessing={false}
                conversationId={conversation.id}
                question={pending!}
                compact
              />
            ) : pending ? (
              <AnswerCard conversationId={conversation.id} question={pending} />
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

/** A message as one preview line: its result, or its prose with the step markers stripped. */
function previewText(m: Message): string {
  if (m.type === 'error') return m.content
  const raw = m.result || m.content || ''
  return raw
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\[tool(:\d+)?\]/.test(l))
    .map((l) => l.replace(/^\[(note|chunk)(:\d+)?\]\s*/, ''))
    .join(' ')
    .trim()
}
