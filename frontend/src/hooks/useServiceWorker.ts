export function useServiceWorker() {
  // Dev servers (the e2e run) have nothing to cache and a SW there only gets in
  // the way of a reload showing the code you just saved.
  if (!import.meta.env.PROD) return
  // Just register the SW for offline caching and push notifications.
  // No auto-update, no auto-reload — updates are applied only on manual reload.
  if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {/* ignore */})
  }
}
