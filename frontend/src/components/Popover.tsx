import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Keep this far from the window's edges. */
const MARGIN = 8

export type Placement = 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start'

interface Props {
  /** The element the panel hangs from — usually the trigger button. */
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  /** Preferred side and alignment; flipped when the window has no room for it. */
  placement?: Placement
  /** Space between the anchor and the panel. */
  gap?: number
  className?: string
  children: ReactNode
}

/**
 * A floating panel anchored to an element: menus, pickers, dropdowns.
 *
 * Rendered into <body> with fixed positioning, so no container's overflow or
 * stacking context can clip it or draw over it — the reason every menu used to
 * be at the mercy of the scroll area it was opened from. Placed from the
 * anchor's box on every open, resize and scroll: it takes the preferred side
 * when that side fits, the roomier side otherwise, slides horizontally to stay
 * inside the window, and caps its height (scrolling inside) when neither side
 * has room for all of it.
 *
 * Closes on a pointer-down outside both the anchor and the panel, and on
 * Escape. React events still bubble through the portal to the component that
 * rendered it, so a panel inside a clickable row should stop propagation.
 */
export default function Popover({ anchor, open, onClose, placement = 'bottom-end', gap = 4, className = '', children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)

  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect()
    const panel = panelRef.current
    if (!a || !panel) return
    const w = panel.offsetWidth
    const h = panel.scrollHeight
    const vw = window.innerWidth
    const vh = window.innerHeight

    const below = vh - a.bottom - gap - MARGIN
    const above = a.top - gap - MARGIN
    const wantsTop = placement.startsWith('top')
    const fitsWanted = (wantsTop ? above : below) >= h
    const top = fitsWanted ? wantsTop : above > below
    const room = top ? above : below
    const height = Math.min(h, room)

    const alignEnd = placement.endsWith('end')
    let left = alignEnd ? a.right - w : a.left
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN))

    setPos({
      top: top ? a.top - gap - height : a.bottom + gap,
      left,
      maxHeight: room,
    })
  }, [anchor, placement, gap])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Capture: a scroll inside any container can move the anchor.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    // Content that changes size while open (a list loading) is re-placed too.
    const ro = new ResizeObserver(place)
    if (panelRef.current) ro.observe(panelRef.current)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      ro.disconnect()
    }
  }, [open, place, onClose, anchor])

  if (!open) return null
  return createPortal(
    <div
      ref={panelRef}
      className={`fixed z-[1000] overflow-y-auto ${className}`}
      // Measured first, shown once placed — never a frame at the wrong spot.
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}
