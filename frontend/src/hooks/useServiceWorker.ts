export function useServiceWorker() {
  // Just register the SW for offline caching and push notifications.
  // No auto-update, no auto-reload — updates are applied only on manual reload.
  if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {/* ignore */})
  }
}
