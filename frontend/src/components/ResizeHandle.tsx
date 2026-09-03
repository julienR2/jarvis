import { useRef } from 'react'

/**
 * The draggable seam between two panes.
 *
 * Double-click restores the default width. A pane you can resize but not put
 * back is a one-way door, and "how wide was this originally?" isn't a question
 * a layout should make anyone answer.
 *
 * Deliberately invisible until hovered: both seams already have a border from
 * the pane beside them, so drawing another line here would double it. What the
 * handle adds is a hit area wide enough to grab — a 1px target is a fiddly one
 * — and an accent line to confirm you've got it.
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
      className='group relative z-30 flex w-1.5 shrink-0 cursor-col-resize select-none items-stretch justify-center'
    >
      <span className='w-px bg-transparent transition-colors group-hover:bg-accent' />
    </div>
  )
}
