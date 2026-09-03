// Service worker — caching for fast PWA loads + share target support.

const CACHE_NAME = 'jarvis-v4'

// ── Install ──────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  // Take over as soon as we're installed. Without this a new worker sits in
  // "waiting" until every Jarvis tab and PWA window on the device is closed —
  // so a fix to push handling could take days to reach a phone that never
  // fully closes the app, with no sign anything was pending.
  self.skipWaiting()
  // Pre-cache the app shell (just the HTML — JS/CSS have hashed URLs and get cached at runtime)
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['/']))
  )
})

// ── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  // Claim open pages too, so they talk to this worker without a reload.
  self.clients.claim()
  // Clean up old cache versions
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('jarvis-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  )
})

// ── Push Notifications ───────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return

  let data
  try {
    data = event.data.json()
  } catch {
    data = { title: 'Jarvis', body: event.data.text() }
  }

  const { title = 'Jarvis', body = '', url, type } = data
  const tagFor = (u) => (u ? `jarvis-${u}` : 'jarvis')

  // A dismissal carries no title: another device read this chat, so take its
  // notification down here too rather than showing anything.
  if (type === 'dismiss') {
    event.waitUntil(
      self.registration
        .getNotifications({ tag: tagFor(url) })
        .then((ns) => ns.forEach((n) => n.close())),
    )
    return
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Only the conversation you are actually looking at suppresses its own
      // notification. Suppressing whenever *any* window was focused meant a
      // reply in another chat vanished silently while you worked in this one:
      // no notification, and nothing to bring you back to it.
      //
      // `focused` rather than `visibilityState` because on macOS a PWA window
      // behind other windows still reports 'visible' — only minimised is 'hidden'.
      const focused = clients.filter((c) => c.focused)
      const viewingThis = focused.some((c) => {
        if (!url) return true // no conversation to compare — old blanket behaviour
        try {
          return new URL(c.url).pathname === url
        } catch {
          return false
        }
      })
      if (viewingThis) return

      return self.registration.showNotification(title, {
        body,
        icon: new URL('/icons/icon-192.png', self.location.origin).href,
        badge: new URL('/icons/badge-96.png', self.location.origin).href,
        tag: tagFor(url),
        renotify: true,
        data: { url: url || '/' },
      })
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const url = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if open
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          client.navigate(url)
          return client.focus()
        }
      }
      // Otherwise open a new one
      return self.clients.openWindow(url)
    })
  )
})

// ── Fetch ────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Share target POST — handle before anything else
  if (url.pathname === '/share' && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request))
    return
  }

  // Never cache API, WebSocket, or internal requests
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws/') ||
    url.pathname.startsWith('/internal/') ||
    url.pathname === '/health'
  ) {
    return // Let the browser handle it normally
  }

  // Hashed assets (/assets/*) — cache-first (immutable content-hashed filenames)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(event.request))
    return
  }

  // Static resources (icons, manifest, fonts) — cache-first
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json' ||
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com'
  ) {
    event.respondWith(cacheFirst(event.request))
    return
  }

  // Navigation requests (HTML) — network-first so rebuilds are visible on refresh
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request))
    return
  }

  // Everything else — network-first with cache fallback
  event.respondWith(networkFirst(event.request))
})

// ── Strategies ───────────────────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    return new Response('', { status: 408 })
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    return cached || new Response('', { status: 408 })
  }
}

// ── Share Target ─────────────────────────────────────────────────────────────

async function handleShareTarget(request) {
  const formData = await request.formData()
  const title = formData.get('title') || ''
  const text = formData.get('text') || ''
  const urlParam = formData.get('url') || ''
  const files = formData.getAll('files')

  const params = new URLSearchParams()
  if (title) params.set('title', title)
  if (text) params.set('text', text)
  if (urlParam) params.set('url', urlParam)

  if (files.length > 0 && files[0] instanceof File) {
    const cache = await caches.open('shared-files')
    const keys = await cache.keys()
    for (const key of keys) await cache.delete(key)

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const response = new Response(file, {
        headers: {
          'Content-Type': file.type,
          'X-Original-Name': encodeURIComponent(file.name),
        },
      })
      await cache.put(`/shared-file/${i}`, response)
    }
    params.set('hasFiles', files.length.toString())
  }

  return Response.redirect(`/share?${params.toString()}`, 303)
}
