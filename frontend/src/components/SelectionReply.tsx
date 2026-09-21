import { useEffect, useState, type RefObject } from 'react'
import { Reply } from 'lucide-react'
import type { ReplyTo } from '../api'

interface Props {
  /** The pane the messages scroll in; the button is positioned inside it. */
  paneRef: RefObject<HTMLElement | null>
  onQuote: (quote: ReplyTo) => void
}

/**
 * Reply to a passage. Selecting text inside a message brings a small round
 * button to the right edge of the pane, level with the selection; pressing it
 * takes the selected text as a quote, clears the selection and hands the quote
 * to the composer. The selection itself is the browser's — nothing is drawn
 * over it — so copying still works the usual way.
 */
export default function SelectionReply({ paneRef, onQuote }: Props) {
  const [target, setTarget] = useState<{ top: number; quote: ReplyTo } | null>(null)

  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    let raf = 0

    const update = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setTarget(null)
      const text = sel.toString().replace(/\s+\n/g, '\n').trim()
      if (!text) return setTarget(null)
      const range = sel.getRangeAt(0)
      const node = range.commonAncestorContainer
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
      // Only a selection that lives inside one message is a passage to reply
      // to; one straddling two bubbles, or in the composer, is not.
      const bubble = el?.closest<HTMLElement>('[data-message-id]')
      if (!bubble || !pane.contains(bubble)) return setTarget(null)
      const rect = range.getBoundingClientRect()
      if (!rect.height) return setTarget(null)
      const box = pane.getBoundingClientRect()
      const top = Math.min(box.height - 24, Math.max(24, rect.top - box.top + rect.height / 2))
      setTarget({ top, quote: { message_id: bubble.dataset.messageId!, text: text.slice(0, 2000) } })
    }
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(update)
    }
    document.addEventListener('selectionchange', schedule)
    // Scroll events do not bubble; capture catches the list's.
    pane.addEventListener('scroll', schedule, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('selectionchange', schedule)
      pane.removeEventListener('scroll', schedule, true)
    }
  }, [paneRef])

  if (!target) return null
  return (
    <button
      type='button'
      data-testid='reply-selection'
      title='Reply to this passage'
      // mousedown would collapse the selection before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(target.quote)
        window.getSelection()?.removeAllRanges()
        setTarget(null)
      }}
      style={{ top: target.top }}
      className='absolute right-3 z-20 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg-alt text-text-muted shadow-md transition-colors hover:text-accent animate-fade-in'
    >
      <Reply size={14} />
    </button>
  )
}
