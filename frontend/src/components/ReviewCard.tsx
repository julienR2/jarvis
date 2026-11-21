import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Maximize2, Minimize2, PenLine, Send, Sparkles, Undo2, X } from 'lucide-react'
import { reviewOf, type PendingQuestion, type ReviewDraft } from '../api'
import { submitAnswer } from './AnswerCard'
import DraftEnvelope from './DraftEnvelope'
import { clearReviewEdit, getReviewEdit, setReviewEdit } from '../lib/reviewEdits'

/** Below this width there is no room to edit in place beside a keyboard. */
const PHONE = '(max-width: 767px)'

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE)
    const on = () => setPhone(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return phone
}

/**
 * A text Jarvis is about to send or publish (its review_text tool), editable,
 * then approved with Send. Approved as is, Jarvis sends it; edited, Jarvis
 * fixes small slips and sends, or — if it would change more than that — asks
 * once more. Polish hands it back unsent: Jarvis looks it over and shows it
 * again. The composer's input is the other answer — what to change, sent as a
 * reply (see answerFromComposer), with any edit made here going along.
 *
 * Two places: `chat`, a card at the end of the conversation — edited in place
 * on a wide screen, opened full screen on a phone, where the keyboard leaves
 * no room for it inline; `composer`, the strip on top of a Today card's input.
 *
 * Like every answer, nothing is removed here: the backend clears the pending
 * prompt over SSE once the engine has it.
 */
export default function ReviewCard({
  conversationId,
  question,
  variant = 'composer',
}: {
  conversationId: string
  question: PendingQuestion
  variant?: 'chat' | 'composer'
}) {
  const draft = reviewOf(question) ?? { text: '', note: '', to: '', cc: '', subject: '', attachments: [] }
  const id = question.request_id
  const [text, setTextState] = useState(() => getReviewEdit(id) ?? draft.text)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const phone = usePhone()
  const edited = text.trim() !== draft.text.trim()

  function setText(value: string) {
    if (value.trim() === draft.text.trim()) clearReviewEdit(id)
    else setReviewEdit(id, value)
    setTextState(value)
  }

  async function answer(body: { behavior: 'allow'; text: string; polish?: boolean } | { behavior: 'deny' }) {
    if (busy) return
    setBusy(true)
    try {
      await submitAnswer(conversationId, question, body)
      clearReviewEdit(id)
      setExpanded(false)
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

  const send = () => void answer({ behavior: 'allow', text })
  const polish = () => void answer({ behavior: 'allow', text, polish: true })
  const discard = () => void answer({ behavior: 'deny' })
  const undo = () => setText(draft.text)
  const actions = { busy, edited, canSend: !!text.trim(), send, polish, discard, undo, copy }

  if (variant === 'composer') {
    return (
      <div
        className='border-b border-warning/30 bg-warning/5 px-4 py-2.5 rounded-t-2xl animate-fade-in'
        data-testid='review-card'
        data-request-id={id}
      >
        <Heading draft={draft} />
        <DraftEnvelope envelope={draft} className='mb-2' />
        <Editor
          text={text}
          onChange={setText}
          onSend={send}
          disabled={busy}
          cap={0.45}
          className='rounded-lg border border-border bg-surface px-3 py-2 focus:border-warning focus:ring-2 focus:ring-warning/15'
        />
        <Footer {...actions} />
      </div>
    )
  }

  return (
    <>
      <div
        className='my-4 rounded-2xl border border-warning/40 bg-surface shadow-sm animate-fade-in'
        data-testid='review-card'
        data-request-id={id}
      >
        <div className='flex items-start gap-2 px-4 pt-3'>
          <div className='min-w-0 flex-1'><Heading draft={draft} /></div>
          <IconButton title='Copy the text' onClick={() => void copy()}><Copy size={14} /></IconButton>
          <IconButton title='Open larger' onClick={() => setExpanded(true)} testId='review-expand'><Maximize2 size={14} /></IconButton>
        </div>
        <DraftEnvelope envelope={draft} className='mx-4 mb-1' />
        <div className='px-4'>
          {phone ? (
            // No editing in place under a phone's keyboard: a tap opens the
            // full-screen editor, the text reads here as it will go out.
            <button
              type='button'
              onClick={() => setExpanded(true)}
              aria-label='Edit the text'
              className='block w-full whitespace-pre-wrap break-words py-2 text-left text-[15px] leading-relaxed text-text-primary'
            >
              {text}
            </button>
          ) : (
            <Editor
              text={text}
              onChange={setText}
              onSend={send}
              disabled={busy}
              className='-mx-2 rounded-lg px-2 py-2 text-[15px] hover:bg-bg-alt/60 focus:bg-transparent focus:ring-2 focus:ring-warning/15'
            />
          )}
        </div>
        <div className='border-t border-border px-4 py-2.5'>
          <Footer {...actions} hideCopy />
        </div>
      </div>
      {expanded && createPortal(
        <div
          className='fixed inset-0 z-50 flex h-[100dvh] flex-col bg-bg animate-fade-in'
          data-testid='review-sheet'
          role='dialog'
          aria-label='Edit the text to send'
        >
          <div className='flex items-center gap-1 border-b border-border px-2 py-2'>
            <IconButton title='Back to the chat' onClick={() => setExpanded(false)}><Minimize2 size={18} /></IconButton>
            <span className='min-w-0 flex-1 truncate px-1 text-[13px] text-text-secondary'>{draft.note || 'Ready to send'}</span>
            {edited && <IconButton title="Back to Jarvis's version" onClick={undo}><Undo2 size={18} /></IconButton>}
            <IconButton title='Copy the text' onClick={() => void copy()}><Copy size={18} /></IconButton>
            <button
              type='button'
              disabled={busy || !text.trim()}
              onClick={polish}
              title='Have Jarvis look it over and show it again — nothing is sent'
              className='inline-flex items-center gap-1 rounded-lg border border-warning/50 px-2.5 py-1.5 text-[13px] text-warning disabled:opacity-40'
            >
              <Sparkles size={13} /> Polish
            </button>
            <button
              type='button'
              disabled={busy || !text.trim()}
              onClick={send}
              className='inline-flex items-center gap-1 rounded-lg bg-warning px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40'
            >
              <Send size={13} /> Send
            </button>
          </div>
          <DraftEnvelope envelope={draft} className='mx-4 mt-3' />
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
                e.preventDefault()
                send()
              }
              if (e.key === 'Escape') setExpanded(false)
            }}
            disabled={busy}
            aria-label='Text to send'
            className='mx-auto block w-full max-w-3xl flex-1 resize-none bg-transparent px-4 py-3 text-[16px] leading-relaxed text-text-primary outline-none'
          />
        </div>,
        document.body,
      )}
    </>
  )
}

function Heading({ draft }: { draft: ReviewDraft }) {
  return (
    <div className='mb-1.5 flex flex-wrap items-baseline gap-x-1 text-[10px] font-semibold uppercase tracking-wide text-warning/80'>
      <span className='inline-flex items-center gap-1 self-center'><PenLine size={11} /> Ready to send</span>
      {/* Wraps rather than truncating: whatever Jarvis says here is part of what is approved. */}
      {draft.note && <span className='min-w-0 break-words text-[11px] font-medium normal-case tracking-normal text-text-secondary'>· {draft.note}</span>}
    </div>
  )
}

function IconButton({ title, onClick, children, testId }: { title: string; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type='button'
      title={title}
      aria-label={title}
      onClick={onClick}
      data-testid={testId}
      className='shrink-0 rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-alt hover:text-text-primary'
    >
      {children}
    </button>
  )
}

/**
 * The text, editable, growing with what it holds. In the composer it stops at
 * a share of the screen (`cap`) and scrolls; in the chat it takes the room it
 * needs, the conversation scrolling instead.
 */
function Editor({ text, onChange, onSend, disabled, cap, className }: {
  text: string
  onChange: (v: string) => void
  onSend: () => void
  disabled: boolean
  cap?: number
  className: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Measured again when the width changes (a pane opening, the window
  // resized), which rewraps the same text onto more or fewer lines.
  const fit = useCallback(() => {
    const t = ref.current
    if (!t) return
    t.style.height = 'auto'
    if (!t.scrollHeight) return
    const h = t.scrollHeight + 2
    t.style.height = `${cap ? Math.min(h, Math.round(window.innerHeight * cap)) : h}px`
  }, [cap])
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
  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
          e.preventDefault()
          onSend()
        }
      }}
      disabled={disabled}
      aria-label='Text to send'
      rows={1}
      className={`block w-full resize-none ${cap ? 'overflow-y-auto' : 'overflow-hidden'} text-sm leading-relaxed text-text-primary outline-none transition-colors disabled:opacity-60 ${className}`}
    />
  )
}

function Footer({ busy, edited, canSend, send, polish, discard, undo, copy, hideCopy }: {
  busy: boolean
  edited: boolean
  canSend: boolean
  send: () => void
  polish: () => void
  discard: () => void
  undo: () => void
  copy: () => Promise<void>
  hideCopy?: boolean
}) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${hideCopy ? '' : 'mt-2'}`}>
      <button
        type='button'
        disabled={busy}
        onClick={discard}
        title="Don't send it"
        className='inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[13px] text-text-secondary transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-40'
      >
        <X size={13} /> Discard
      </button>
      {!hideCopy && (
        <button
          type='button'
          onClick={() => void copy()}
          title='Copy the text'
          className='inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[13px] text-text-secondary transition-colors hover:text-text-primary'
        >
          <Copy size={13} /> Copy
        </button>
      )}
      {edited && (
        <button
          type='button'
          disabled={busy}
          onClick={undo}
          title="Back to Jarvis's version"
          className='inline-flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[12px] text-text-muted transition-colors hover:text-text-primary'
        >
          <Undo2 size={12} /> Undo edits
        </button>
      )}
      <span className='ml-auto flex items-center gap-2'>
        {edited && <span className='hidden text-[11px] text-text-muted md:inline'>Small fixes are made and sent; bigger ones come back to you</span>}
        <button
          type='button'
          disabled={busy || !canSend}
          onClick={polish}
          title='Have Jarvis look it over and show it again — nothing is sent'
          className='inline-flex items-center gap-1 rounded-lg border border-warning/50 px-2.5 py-1.5 text-[13px] text-warning transition-colors hover:bg-warning/10 disabled:opacity-40'
        >
          <Sparkles size={13} /> Polish
        </button>
        <button
          type='button'
          disabled={busy || !canSend}
          onClick={send}
          title={edited ? 'Send your version — Jarvis fixes small slips first, and asks again only for bigger changes (Ctrl+Enter)' : 'Send it (Ctrl+Enter)'}
          className='inline-flex items-center gap-1 rounded-lg bg-warning px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-40'
        >
          <Send size={13} /> Send
        </button>
      </span>
    </div>
  )
}
