// Hard reload: drop the service worker and every cached asset, then reload.
//
// A plain location.reload() can be served the old bundle straight out of the
// service worker's cache, which is exactly the case that matters here — the
// user is reloading *because* Jarvis rebuilt itself and they want the new code.
export async function reloadApp(): Promise<void> {
  try {
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k)))
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) await reg.unregister()
  } catch {
    // Storage APIs can be unavailable (private mode, blocked site data).
    // Reloading with a stale cache still beats not reloading at all.
  }
  window.location.reload()
}
