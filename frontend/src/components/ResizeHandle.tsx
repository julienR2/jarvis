import { useRef } from 'react'

/**
 * The draggable seam between two panes.
 *
 * Double-click restores the default width. A pane you can resize but not put
 * back is a one-way door, and "how wide was this originally?" isn't a question
 * a layout should make anyone answer.
 *
 * Takes no space in the layout. It is a zero-width flex item with the grab
 * strip positioned over the seam, so it lands exactly on the border the pane
 * beside it already draws rather than inserting a column of its own and pushing
 * the panes apart.
 *
 * Invisible until hovered, for the same reason: that border is the line, so
 * drawing another would double it. What the handle adds is a hit area wide
 * enough to grab — a 1px target is a fiddly one — and an accent line on top of
 * the border to confirm you've got it.
 *
 * Rendered by callers only on desktop; see useIsDesktop.
 */
export default function ResizeHandle({
  label,
  onStart,
  onMove,
  onReset,
}: {
  label: string
  /** Drag began — capture whatever the current size is. */
  onStart: () => void
  /** Pixels moved since the drag began, signed. */
  onMove: (deltaX: number) => void
  onReset: () => void
}) {
  const startX = useRef(0)
  const dragging = useRef(false)

  function begin(e: React.PointerEvent<HTMLDivElement>) {
    // Deliberately no preventDefault here. It would be the obvious way to stop
    // the drag selecting text, but preventing pointerdown also suppresses the
    // compatibility mouse events that dblclick is derived from in some
    // browsers — and that would silently cost us the double-click reset. The
    // body's userSelect below stops the selection instead.
    startX.current = e.clientX
    dragging.current = true
    onStart()
    // Capture keeps the events coming even when the cursor outruns the handle,
    // which it does on any quick drag.
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  function move(e: React.PointerEvent<HTMLDivElement>) {
    if (dragging.current) onMove(e.clientX - startX.current)
  }

  function end(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  return (
    // Zero-width and shrink-0: contributes nothing to the split.
    <div className='relative w-0 shrink-0'>
      <div
        role='separator'
        aria-orientation='vertical'
        aria-label={label}
        title={`${label} — double-click to reset`}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={onReset}
        // Straddles the seam, so half the grab area falls on each pane. z-50
        // clears the sidebar's own z-40, which would otherwise swallow the
        // half of the strip that overlaps it.
        className='group absolute inset-y-0 left-1/2 z-50 flex w-2 -translate-x-1/2 cursor-col-resize select-none items-stretch justify-center'
      >
        {/* -left-px: the seam falls just right of the neighbour's 1px border,
            so the line has to step back onto it rather than sit beside it. */}
        <span className='relative -left-px w-px bg-transparent transition-colors group-hover:bg-accent' />
      </div>
    </div>
  )
}
