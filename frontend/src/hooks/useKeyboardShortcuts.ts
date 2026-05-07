import { useEffect } from 'react'

export interface Shortcut {
  key: string          // e.g. 'n', 'k', 'Escape'
  meta?: boolean       // Cmd (Mac) / Ctrl (Windows)
  shift?: boolean
  alt?: boolean
  action: () => void
  description?: string // for future help overlay
}

export function useKeyboardShortcuts(shortcuts: Shortcut[]) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      for (const shortcut of shortcuts) {
        const metaMatch = shortcut.meta ? (e.metaKey || e.ctrlKey) : (!e.metaKey && !e.ctrlKey)
        const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey
        const altMatch = shortcut.alt ? e.altKey : !e.altKey
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase()

        if (keyMatch && metaMatch && shiftMatch && altMatch) {
          e.preventDefault()
          shortcut.action()
          return
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcuts])
}
