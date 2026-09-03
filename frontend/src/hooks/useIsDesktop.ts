import { useSyncExternalStore } from 'react'

// Tailwind's `md`, the breakpoint the whole layout already switches on.
const QUERY = '(min-width: 768px)'

const mq = typeof window !== 'undefined' ? window.matchMedia(QUERY) : null

function subscribe(onChange: () => void): () => void {
  mq?.addEventListener('change', onChange)
  return () => mq?.removeEventListener('change', onChange)
}

/**
 * Whether the desktop layout is in force.
 *
 * Pane resizing is desktop-only and this is what gates it. On mobile the
 * sidebar is an overlay and the app pane *replaces* the chat rather than
 * sitting beside it, so a drag handle would offer to resize something with no
 * neighbour to take the space — and the stored width has to stay off those
 * panes too, since inline styles ignore breakpoints.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, () => mq?.matches ?? true, () => true)
}
