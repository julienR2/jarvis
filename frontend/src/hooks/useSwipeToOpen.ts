import { useRef, useEffect, useCallback } from 'react'
import { flushSync } from 'react-dom'

interface Options {
  onOpen: () => void
  onClose: () => void
  isOpen: boolean
  sidebarWidth: number
}

// iOS reserves the leftmost ~20 px for its system back-swipe; engaging the
// sidebar drag inside that band leaves it half-open when the system steals the gesture.
const EDGE_SLOP = 20

/** Whether a scroller under the finger can still move the way a swipe goes. */
type CanScroll = (dx: number) => boolean

/**
 * What an app's frame forwards of a touch (see backend/src/app-swipe-bridge.ts).
 * Touches inside an iframe never reach this document, so without it a swipe
 * that starts on an app could not open the sidebar.
 */
interface FrameSwipe {
  type: 'jarvis:swipe'
  phase: 'start' | 'move' | 'end' | 'cancel' | 'yield'
  x: number
  y: number
  /** The app handles horizontal touches itself (touch-action without pan-x). */
  owned?: boolean
  canLeft?: boolean
  canRight?: boolean
}

/**
 * Handles swipe-to-open / swipe-to-close for a sidebar.
 * Drives sidebar position and overlay opacity imperatively via DOM refs — no React
 * re-renders during the drag. Only re-renders once on snap (when sidebarOpen flips).
 *
 * A swipe that starts inside an app's frame arrives as messages from it and
 * goes through the same steps, the app keeping first claim on the gesture: a
 * scroller of its own that can still move, or a touch it handles itself.
 */
export function useSwipeToOpen({ onOpen, onClose, isOpen, sidebarWidth }: Options) {
  const isDraggingRef = useRef(false)
  const touchInScrollableRef = useRef(false)   // gesture ceded to a child scroller
  const canScrollRef = useRef<CanScroll | null>(null) // the scroller under the finger, if any
  const startXRef = useRef(0)
  const startYRef = useRef(0)
  const startTimeRef = useRef(0)
  const currentXRef = useRef(0)   // 0 = fully closed, sidebarWidth = fully open
  const elemWidthRef = useRef(sidebarWidth) // actual px width, read on drag start
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isOpenRef = useRef(isOpen)
  useEffect(() => { isOpenRef.current = isOpen }, [isOpen])

  const containerRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  // x=0 → fully off-screen (matches -translate-x-full), x=elemWidth → visible
  // Uses style.translate to override Tailwind v4's `translate` property (not `transform`)
  function setSidebarX(x: number) {
    if (sidebarRef.current)
      sidebarRef.current.style.translate = `${x - elemWidthRef.current}px`
  }

  function setOverlayOpacity(x: number) {
    if (overlayRef.current)
      overlayRef.current.style.opacity = String((x / sidebarWidth) * 0.6)
  }

  // The steps of a gesture, in viewport coordinates: fed by this document's
  // touches and by an app frame's alike. Plain functions reading refs, so the
  // frame's message listener can hold them without re-subscribing.
  function begin(x: number, y: number, canScroll: CanScroll | null, ceded = false) {
    // Cancel any in-progress snap animation
    if (snapTimerRef.current) {
      clearTimeout(snapTimerRef.current)
      snapTimerRef.current = null
      if (sidebarRef.current) { sidebarRef.current.style.translate = ''; sidebarRef.current.style.transition = '' }
      if (overlayRef.current) overlayRef.current.style.transition = ''
    }

    startXRef.current = x
    startYRef.current = y
    startTimeRef.current = Date.now()
    isDraggingRef.current = false
    currentXRef.current = isOpenRef.current ? sidebarWidth : 0
    // Read actual width so our pixel offset matches translateX(-100%) exactly
    elemWidthRef.current = sidebarRef.current?.offsetWidth ?? sidebarWidth
    touchInScrollableRef.current = ceded
    canScrollRef.current = canScroll
  }

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // Find the nearest ancestor that is a genuine horizontal scroll container
    // with content to scroll (a code block or table). It must be checked against
    // computed overflow-x — an element that merely clips or lets content overflow
    // (overflow-x: hidden/clip/visible) also reports scrollWidth > clientWidth but
    // does NOT scroll, so it must not steal the swipe.
    let scroller: HTMLElement | null = null
    let el = e.target as HTMLElement | null
    while (el && el !== containerRef.current) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const ox = getComputedStyle(el).overflowX
        if (ox === 'auto' || ox === 'scroll') { scroller = el; break }
      }
      el = el.parentElement
    }
    // Swipe right (dx>0) reveals left content → needs scrollLeft > 0;
    // swipe left (dx<0) reveals right content → needs room before the right edge.
    const sc = scroller
    begin(e.touches[0].clientX, e.touches[0].clientY, sc && ((dx) =>
      dx > 0 ? sc.scrollLeft > 1 : sc.scrollLeft < sc.scrollWidth - sc.clientWidth - 1))
  }, [sidebarWidth]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Returns whether the sidebar is being dragged. */
  function move(x: number, y: number): boolean {
    if (touchInScrollableRef.current) return false

    const dx = x - startXRef.current
    const dy = y - startYRef.current

    if (!isDraggingRef.current) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return false
      if (Math.abs(dy) >= Math.abs(dx)) return false
      if (isOpenRef.current && dx > 0) return false
      if (!isOpenRef.current && dx < 0) return false
      // Don't engage if the swipe started inside the system back-gesture band
      if (!isOpenRef.current && startXRef.current < EDGE_SLOP) return false

      // If a horizontal scroll container is under the finger and can still scroll
      // in the swipe direction, let it scroll instead of moving the sidebar.
      // At the edge in that direction, the gesture falls through to the sidebar.
      if (canScrollRef.current?.(dx)) { touchInScrollableRef.current = true; return false }

      isDraggingRef.current = true
      // Freeze transitions — we drive position directly
      if (sidebarRef.current) sidebarRef.current.style.transition = 'none'
      if (overlayRef.current) {
        overlayRef.current.style.transition = 'none'
        overlayRef.current.style.pointerEvents = 'auto'
      }
    }

    const base = isOpenRef.current ? sidebarWidth : 0
    const clamped = Math.max(0, Math.min(sidebarWidth, base + dx))
    currentXRef.current = clamped
    setSidebarX(clamped)
    setOverlayOpacity(clamped)
    return true
  }

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    move(e.touches[0].clientX, e.touches[0].clientY)
  }, [sidebarWidth]) // eslint-disable-line react-hooks/exhaustive-deps

  function end() {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false

    const pos = currentXRef.current
    const rawDx = pos - (isOpenRef.current ? sidebarWidth : 0)
    const dt = Math.max(1, Date.now() - startTimeRef.current)
    const velocity = rawDx / dt

    const shouldOpen = !isOpenRef.current && (pos > (sidebarWidth * 2) / 3 || velocity > 0.4)
    const shouldClose = isOpenRef.current && (pos < sidebarWidth / 3 || velocity < -0.4)

    // Target position for the snap animation
    const targetX = shouldOpen ? sidebarWidth : shouldClose ? 0 : isOpenRef.current ? sidebarWidth : 0
    const targetOpacity = targetX > 0 ? 0.6 : 0

    // Animate to snap target imperatively (no React re-render yet)
    if (sidebarRef.current) {
      sidebarRef.current.style.transition = 'translate 200ms'
      setSidebarX(targetX)
    }
    if (overlayRef.current) {
      overlayRef.current.style.transition = 'opacity 200ms'
      overlayRef.current.style.opacity = String(targetOpacity)
      overlayRef.current.style.pointerEvents = targetOpacity > 0 ? 'auto' : 'none'
    }

    // After animation: flush React state first so CSS classes update to the new position
    // BEFORE we clear inline styles — otherwise the old CSS class briefly flashes.
    snapTimerRef.current = setTimeout(() => {
      snapTimerRef.current = null
      // flushSync ensures the CSS class (translate-x-0 / -translate-x-full) reflects the
      // new sidebarOpen value synchronously, so clearing style.translate causes no visual jump.
      if (shouldOpen) flushSync(onOpen)
      else if (shouldClose) flushSync(onClose)
      if (sidebarRef.current) { sidebarRef.current.style.translate = ''; sidebarRef.current.style.transition = '' }
      if (overlayRef.current) overlayRef.current.style.transition = ''
    }, 210)
  }

  const onTouchEnd = useCallback(end, [onOpen, onClose, sidebarWidth]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fired when the system steals the gesture (e.g. iOS back-swipe). Snap back to
  // the committed state and clear inline styles so the sidebar isn't left half-open.
  function cancel() {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false

    const targetX = isOpenRef.current ? sidebarWidth : 0
    const targetOpacity = isOpenRef.current ? 0.6 : 0

    if (sidebarRef.current) {
      sidebarRef.current.style.transition = 'translate 200ms'
      setSidebarX(targetX)
    }
    if (overlayRef.current) {
      overlayRef.current.style.transition = 'opacity 200ms'
      overlayRef.current.style.opacity = String(targetOpacity)
      overlayRef.current.style.pointerEvents = targetOpacity > 0 ? 'auto' : 'none'
    }

    snapTimerRef.current = setTimeout(() => {
      snapTimerRef.current = null
      if (sidebarRef.current) { sidebarRef.current.style.translate = ''; sidebarRef.current.style.transition = '' }
      if (overlayRef.current) overlayRef.current.style.transition = ''
    }, 210)
  }

  const onTouchCancel = useCallback(cancel, [sidebarWidth]) // eslint-disable-line react-hooks/exhaustive-deps

  // The latest steps, for the frame listener below (end() closes over onOpen).
  const stepsRef = useRef({ begin, move, end, cancel })
  stepsRef.current = { begin, move, end, cancel }

  // A swipe inside an app's frame, forwarded by the bridge the backend puts in
  // every app page. Only frames inside this layout count, and their touch
  // points are in the frame's own coordinates.
  useEffect(() => {
    let claimed = false
    function onMessage(e: MessageEvent) {
      const d = e.data as FrameSwipe | null
      if (d?.type !== 'jarvis:swipe') return
      const frame = Array.from(containerRef.current?.querySelectorAll('iframe') ?? [])
        .find((f) => f.contentWindow === e.source)
      if (!frame) return
      const r = frame.getBoundingClientRect()
      const x = r.left + d.x
      const y = r.top + d.y
      const steps = stepsRef.current
      switch (d.phase) {
        case 'start':
          claimed = false
          steps.begin(x, y, (dx) => !!(dx > 0 ? d.canLeft : d.canRight), !!d.owned)
          break
        case 'move':
          // Once the sidebar has it, the frame stops scrolling along with it.
          if (steps.move(x, y) && !claimed) {
            claimed = true
            ;(e.source as Window).postMessage({ type: 'jarvis:swipe-claim' }, '*')
          }
          break
        // The app took the touch for itself before the sidebar engaged.
        case 'yield':
          if (!isDraggingRef.current) touchInScrollableRef.current = true
          break
        case 'end':
          steps.end()
          break
        case 'cancel':
          steps.cancel()
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Non-passive touchmove to suppress scroll while swiping
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: TouchEvent) => { if (isDraggingRef.current) e.preventDefault() }
    el.addEventListener('touchmove', handler, { passive: false })
    return () => el.removeEventListener('touchmove', handler)
  }, [])

  return { containerRef, sidebarRef, overlayRef, handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } }
}
