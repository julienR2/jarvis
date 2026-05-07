import { useRef, useCallback } from 'react'

export function useLongPress(onLongPress: () => void, delay = 500) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firedRef = useRef(false)

  const start = useCallback((e: React.TouchEvent) => {
    firedRef.current = false
    timerRef.current = setTimeout(() => {
      firedRef.current = true
      onLongPress()
    }, delay)
  }, [onLongPress, delay])

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return {
    onTouchStart: start,
    onTouchEnd: cancel,
    onTouchMove: cancel,
    onContextMenu: useCallback((e: React.MouseEvent) => {
      if (firedRef.current) e.preventDefault()
    }, []),
  }
}
