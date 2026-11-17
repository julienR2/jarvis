import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, PenLine, Send, Undo2, X } from 'lucide-react'
import { reviewOf, type PendingQuestion } from '../api'
import { submitAnswer } from './AnswerCard'
import DraftEnvelope from './DraftEnvelope'

// What was typed into a draft, by prompt: survives the card unmounting (another
// chat opened, the Today card collapsed) for as long as the page lives.
const edits = new Map<string, string>()

/**
 * A text Jarvis is about to send or publish (its review_text tool), at the head
 * of the composer: editable in place, then approved with Send. Approved as is,
 * Jarvis sends it; edited, Jarvis tidies the person's version and asks once
 * more. The composer's own input below is the other answer — what to change,
 * sent as a reply, as for an approval (see answerFromComposer).
 *
 * Like every answer, nothing is removed here: the backend clears the pending
 * prompt over SSE once the engine has it.
 */
export default function ReviewCard({ conversationId, question }: { conversationId: string; question: PendingQuestion }) {
  const draft = reviewOf(question) ?? { text: '', note: '', to: '', cc: '', subject: '', attachments: [] }
  const id = question.request_id
  const [text, setTextState] = useState(() => edits.get(id) ?? draft.text)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const edited = text.trim() !== draft.text.trim()

  function setText(value: string) {
    edits.set(id, value)
    setTextState(value)
  }

  // Grows with the text up to a cap, past which it scrolls — measured again
  // when its width changes (a pane opening, the phone turning), which rewraps
  // the same text onto more or fewer lines.
  const fit = useCallback(() => {
    const t = ref.current
    if (!t) return
    t.style.height = 'auto'
    if (t.scrollHeight) t.style.height = `${Math.min(t.scrollHeight + 2, Math.round(window.innerHeight * 0.45))}px`
  }, [])
  useLayoutEffect(fit, [text, fit])
  useEffect(() => {
    const t = ref.current
    if (!t || typeof ResizeObserver === 'undefined') return
    let width = -1
    const observer = new ResizeObserver(([entry]) => {
      // Only the width: the height is ours to set, and reacting to it would loop.
      if (entry.contentRect.width === width) return
      width = entry.contentRect.width
      fit()
    })
    observer.observe(t)
    return () => observer.disconnect()
  }, [fit])

  async function answer(body: { behavior: 'allow'; text: string } | { behavior: 'deny' }) {
    if (busy) return
    setBusy(true)
    try {
      await submitAnswer(conversationId, question, body)
      edits.delete(id)
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      window.__jarvisToast?.success('Copied.')
    } catch {
      window.__jarvisToast?.error("Couldn't copy.")
    }
  }

  return (
    <div
      className='border-b border-warning/30 bg-warning/5 px-4 py-2.5 rounded-t-2xl animate-fade-in'
      data-testid='review-card'
      data-request-id={id}
    >
      <div className='mb-1.5 flex flex-wrap items-baseline gap-x-1 text-[10px] font-semibold uppercase tracking-wide text-warning/80'>
        <span className='inline-flex items-center gap-1 self-center'><PenLine size={11} /> Ready to send</span>
        {/* Wraps rather than truncating: whatever Jarvis says here is part of what is approved. */}
        {draft.note && <span className='min-w-0 break-words text-[11px] font-medium normal-case tracking-normal text-text-secondary'>· {draft.note}</span>}
      </div>
      <DraftEnvelope envelope={draft} className='mb-2' />
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
            e.preventDefault()
            void answer({ behavior: 'allow', text })
          }
        }}
        disabled={busy}
        aria-label='Text to send'
        rows={1}
        className='block w-full resize-none overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-text-primary outline-none transition-colors focus:border-warning focus:ring-2 focus:ring-warning/15 disabled:opacity-60'
      />
      <div className='mt-2 flex flex-wrap items-center gap-1.5'>
        <button
          type='button'
          disabled={busy}
          onClick={() => void answer({ behavior: 'deny' })}
          title="Don't send it"
          className='inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[13px] text-text-secondary transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-40'
        >
          <X size={13} /> Discard
        </button>
        <button
          type='button'
          onClick={() => void copy()}
          title='Copy the text'
          className='inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[13px] text-text-secondary transition-colors hover:text-text-primary'
        >
          <Copy size={13} /> Copy
        </button>
        {edited && (
          <button
            type='button'
            disabled={busy}
            onClick={() => setText(draft.text)}
            title="Back to Jarvis's version"
            className='inline-flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[12px] text-text-muted transition-colors hover:text-text-primary'
          >
            <Undo2 size={12} /> Undo edits
          </button>
        )}
        <span className='ml-auto flex items-center gap-2'>
          {edited && <span className='hidden text-[11px] text-text-muted sm:inline'>Jarvis checks your edits, then asks once more</span>}
          <button
            type='button'
            disabled={busy || !text.trim()}
            onClick={() => void answer({ behavior: 'allow', text })}
            title={edited ? 'Send your version to Jarvis to check (Ctrl+Enter)' : 'Send it (Ctrl+Enter)'}
            className='inline-flex items-center gap-1 rounded-lg bg-warning px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-40'
          >
            <Send size={13} /> Send
          </button>
        </span>
      </div>
    </div>
  )
}
