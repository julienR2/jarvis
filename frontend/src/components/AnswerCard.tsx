import { useState } from 'react'
import { Check, MessageCircleQuestion, PencilLine, ShieldCheck, X } from 'lucide-react'
import { api, describePending, questionsOf, type AskQuestion, type Attachment, type PendingQuestion } from '../api'
import { useChatStore } from '../stores/chatStore'

/**
 * Jarvis is waiting on you, shown where there is no composer to fold into —
 * Today's run rows (`compact`), and the chat's approval strip.
 *
 * A question with options is answered here by picking then pressing Answer (no
 * input to type into). In the chat the question is drawn INTO the composer
 * instead (see ChatInput): picking an option sets the input's value, and the
 * composer's own Send is the submit — so this component is not used for chat
 * questions, only for approvals and for Today.
 *
 * The card never removes itself: the answer goes to the backend, which clears
 * the conversation's pending question over SSE for every screen at once.
 */
export default function AnswerCard({
  conversationId,
  question,
  variant = 'compact',
  onOpen,
}: {
  conversationId: string
  question: PendingQuestion
  variant?: 'strip' | 'compact'
  /** How to reach the chat, where a free-form answer can be typed. */
  onOpen?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const questions = questionsOf(question)
  const compact = variant === 'compact'

  async function send(body: Omit<Parameters<typeof api.answerQuestion>[1], 'request_id'>) {
    if (busy) return
    setBusy(true)
    try {
      await submitAnswer(conversationId, question, body)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={compact ? 'rounded-xl border border-warning/40 bg-surface px-3 py-2.5' : 'border-b border-warning/30 bg-warning/5 px-4 py-3 rounded-t-2xl animate-fade-in'}
      data-testid='answer-card'
      data-request-id={question.request_id}
    >
      {!compact && (
        <div className='mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning'>
          <MessageCircleQuestion size={12} /> Jarvis asks
        </div>
      )}
      {questions.length > 0 ? (
        <CompactQuestions questions={questions} busy={busy} onAnswer={(answers) => send({ answers })} onOpen={onOpen} />
      ) : (
        <Approval question={question} busy={busy} onDecide={(behavior, message) => send({ behavior, message })} compact={compact} />
      )}
    </div>
  )
}

/** Whether the open question offers options — the composer input then dims until used. */
export function hasOptions(question: PendingQuestion): boolean {
  return questionsOf(question).some((q) => q.options.length > 0)
}

/**
 * Send an answer and deal with the outcome. `answered: false` means the backend
 * had nothing to deliver it to (the run behind the question is gone) and has
 * already dropped the question; mirror that locally in case the stream is away.
 */
export async function submitAnswer(
  conversationId: string,
  question: PendingQuestion,
  body: Omit<Parameters<typeof api.answerQuestion>[1], 'request_id'>,
): Promise<void> {
  try {
    const res = await api.answerQuestion(conversationId, { request_id: question.request_id, ...body })
    if (!res.answered) {
      window.__jarvisToast?.error(res.error ?? "Couldn't send the answer.")
      useChatStore.getState().setPendingQuestion(conversationId, null)
    }
  } catch (err) {
    console.error('Could not answer:', err)
    window.__jarvisToast?.error("Couldn't send the answer — try again.")
  }
}

/**
 * The composer's Send while a question is open — the chat's whole answer path.
 * The input holds one answer, whether picked (a chip set the value) or typed;
 * it is the answer to the question. Jarvis asks one question at a time, so a
 * single value is the whole answer; were it ever to ask several, the text
 * answers the first.
 */
export async function answerFromComposer(
  conversationId: string,
  question: PendingQuestion,
  text: string,
  attachments: Attachment[],
): Promise<void> {
  const questions = questionsOf(question)
  if (!questions.length || !text.trim()) return
  await submitAnswer(conversationId, question, {
    answers: { [questions[0].question]: text.trim() },
    attachments,
  })
}

// ── Option list ──────────────────────────────────────────────────────────────

/**
 * The options of a question (or several), as a vertical list — each row its
 * full label and description, with a radio dot that fills when chosen. Reads as
 * part of whatever holds it. Selection is the caller's to own: in the chat it
 * is the composer's input value, on Today it is local state — this only draws
 * and reports a tap. The per-question header shows only when there is more than
 * one question, where it tells them apart; a lone question needs no label.
 */
export function OptionList({
  questions, selectedOf, onPick, disabled,
}: {
  questions: AskQuestion[]
  /** Labels currently chosen for this question. */
  selectedOf: (q: AskQuestion) => string[]
  onPick: (q: AskQuestion, label: string) => void
  disabled?: boolean
}) {
  const showHeaders = questions.length > 1
  return (
    <div className='flex flex-col gap-3'>
      {questions.map((q) => {
        const sel = selectedOf(q)
        return (
          <div key={q.question}>
            {showHeaders && q.header && (
              <div className='text-[10px] font-semibold uppercase tracking-wide text-warning/80'>{q.header}</div>
            )}
            <div className='text-[13px] leading-snug text-text-primary'>
              {q.question}
              {q.multiSelect && <span className='ml-1.5 text-[11px] font-normal text-text-muted'>pick any</span>}
            </div>
            <div className='mt-1.5 flex flex-col gap-1'>
              {q.options.map((opt) => {
                const on = sel.includes(opt.label)
                return (
                  <button
                    key={opt.label}
                    type='button'
                    disabled={disabled}
                    onClick={() => onPick(q, opt.label)}
                    aria-pressed={on}
                    className={`group flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:opacity-40 ${
                      on ? 'border-warning bg-warning/10' : 'border-border hover:border-warning/50 hover:bg-warning/5'
                    }`}
                  >
                    <span className={`mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors ${
                      on ? 'border-warning bg-warning text-white' : 'border-border text-transparent group-hover:border-warning/50'
                    }`}>
                      <Check size={10} strokeWidth={3} />
                    </span>
                    <span className='min-w-0'>
                      <span className='block text-[13px] font-medium leading-snug text-text-primary'>{opt.label}</span>
                      {opt.description && <span className='mt-px block text-[12px] leading-snug text-text-muted'>{opt.description}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Today's question card (no composer, so it picks and confirms in place) ────

function CompactQuestions({
  questions, busy, onAnswer, onOpen,
}: {
  questions: AskQuestion[]
  busy: boolean
  onAnswer: (answers: Record<string, string>) => void
  onOpen?: () => void
}) {
  const [picks, setPicks] = useState<Record<string, string>>({})
  const complete = questions.every((q) => picks[q.question])
  const picking = Object.values(picks).some(Boolean)

  function pick(q: AskQuestion, label: string) {
    setPicks((p) => {
      if (q.multiSelect) {
        const cur = p[q.question] ? p[q.question].split(', ') : []
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
        return { ...p, [q.question]: next.join(', ') }
      }
      return { ...p, [q.question]: p[q.question] === label ? '' : label }
    })
  }

  return (
    <div className='flex flex-col gap-2.5'>
      <OptionList questions={questions} selectedOf={(q) => (picks[q.question] ? picks[q.question].split(', ') : [])} onPick={pick} disabled={busy} />
      <div className='flex items-center gap-2 text-[12px] text-text-muted'>
        <button type='button' onClick={onOpen} className='inline-flex items-center gap-1 hover:text-text-primary transition-colors'>
          <PencilLine size={12} /> Something else? Answer in the chat
        </button>
        {picking && (
          <button
            type='button'
            disabled={busy || !complete}
            onClick={() => onAnswer(picks)}
            title={complete ? 'Send this answer' : 'Answer every question first'}
            className='ml-auto inline-flex items-center gap-1 rounded-lg bg-warning px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-40'
          >
            <Check size={13} /> Answer
          </button>
        )}
      </div>
    </div>
  )
}

// ── Approval ─────────────────────────────────────────────────────────────────

function Approval({
  question, busy, onDecide, compact,
}: {
  question: PendingQuestion
  busy: boolean
  onDecide: (behavior: 'allow' | 'deny', message?: string) => void
  compact?: boolean
}) {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const input = question.input as Record<string, unknown>
  const command = typeof input.command === 'string' ? input.command : null
  const detail = command ?? (Object.keys(input).length ? JSON.stringify(input, null, 2) : null)

  return (
    <div className='flex flex-col gap-2'>
      <div className={`${compact ? 'text-[13px]' : 'text-[15px]'} text-text-primary`}>
        {describePending(question)}
      </div>
      {detail && !compact && (
        <pre className='max-h-40 overflow-auto rounded-lg bg-bg-alt px-3 py-2 text-[12px] leading-relaxed text-text-secondary'>{detail.slice(0, 2000)}</pre>
      )}
      <div className='flex flex-wrap items-center gap-1.5'>
        <button
          type='button'
          disabled={busy}
          onClick={() => onDecide('allow')}
          className='inline-flex items-center gap-1 rounded-lg bg-warning px-3 py-1.5 text-[13px] font-medium text-white transition-colors disabled:opacity-40'
        >
          <ShieldCheck size={13} /> Approve
        </button>
        <button
          type='button'
          disabled={busy}
          onClick={() => (denying ? onDecide('deny', reason) : setDenying(true))}
          className='inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-[13px] text-text-secondary transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-40'
        >
          <X size={13} /> Deny
        </button>
        {denying && (
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onDecide('deny', reason) }}
            placeholder='Why not? (optional, Jarvis reads it)'
            className='min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-danger/60'
          />
        )}
      </div>
    </div>
  )
}
