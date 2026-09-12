import { IS_NEXT } from '../base'

export function useServiceWorker() {
  // The next stack shares prod's origin. Its own SW would fight prod's over
  // scope, and there is nothing to cache on a dev server anyway.
  if (IS_NEXT) return
  // Just register the SW for offline caching and push notifications.
  // No auto-update, no auto-reload — updates are applied only on manual reload.
  if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {/* ignore */})
  }
}
