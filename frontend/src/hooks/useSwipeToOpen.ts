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

/**
 * Handles swipe-to-open / swipe-to-close for a sidebar.
 * Drives sidebar position and overlay opacity imperatively via DOM refs — no React
 * re-renders during the drag. Only re-renders once on snap (when sidebarOpen flips).
 */
export function useSwipeToOpen({ onOpen, onClose, isOpen, sidebarWidth }: Options) {
  const isDraggingRef = useRef(false)
  const touchInScrollableRef = useRef(false)
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

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // Cancel any in-progress snap animation
    if (snapTimerRef.current) {
      clearTimeout(snapTimerRef.current)
      snapTimerRef.current = null
      if (sidebarRef.current) { sidebarRef.current.style.translate = ''; sidebarRef.current.style.transition = '' }
      if (overlayRef.current) overlayRef.current.style.transition = ''
    }

    const t = e.touches[0]
    startXRef.current = t.clientX
    startYRef.current = t.clientY
    startTimeRef.current = Date.now()
    isDraggingRef.current = false
    currentXRef.current = isOpenRef.current ? sidebarWidth : 0
    // Read actual width so our pixel offset matches translateX(-100%) exactly
    elemWidthRef.current = sidebarRef.current?.offsetWidth ?? sidebarWidth

    // If the touch started inside a horizontally scrollable element (e.g. a code
    // block or table), let that element own the gesture instead of the sidebar.
    touchInScrollableRef.current = false
    let el = e.target as HTMLElement | null
    while (el && el !== containerRef.current) {
      if (el.scrollWidth > el.clientWidth + 1) {
        touchInScrollableRef.current = true
        break
      }
      el = el.parentElement
    }
  }, [sidebarWidth])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchInScrollableRef.current) return

    const t = e.touches[0]
    const dx = t.clientX - startXRef.current
    const dy = t.clientY - startYRef.current

    if (!isDraggingRef.current) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (Math.abs(dy) >= Math.abs(dx)) return
      if (isOpenRef.current && dx > 0) return
      if (!isOpenRef.current && dx < 0) return
      // Don't engage if the swipe started inside the system back-gesture band
      if (!isOpenRef.current && startXRef.current < EDGE_SLOP) return
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
  }, [sidebarWidth]) // eslint-disable-line react-hooks/exhaustive-deps

  const onTouchEnd = useCallback(() => {
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
  }, [onOpen, onClose, sidebarWidth]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fired when the system steals the gesture (e.g. iOS back-swipe). Snap back to
  // the committed state and clear inline styles so the sidebar isn't left half-open.
  const onTouchCancel = useCallback(() => {
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
  }, [sidebarWidth]) // eslint-disable-line react-hooks/exhaustive-deps

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
