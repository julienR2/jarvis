import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The generic `backend` alias is ambiguous when several Jarvis clones share a
// Docker network (each stack's service gets the same alias, and Docker DNS
// round-robins across them). Multi-instance setups pin BACKEND_URL to the
// clone's container name in docker-compose.override.yml.
const backendUrl = process.env.BACKEND_URL || 'http://backend:3005'

// Mount point. Prod is `/`; the next stack is served by the reverse proxy under
// `/next/` on prod's origin (same login, no mixed content). With a prefix the
// dev server sees `/next/api/...`, so the proxy has to match and strip it.
//
// The API key is `/api/` WITH the slash: vite matches proxy keys by prefix, and
// a bare `/api` also captured the `/api-keys` page, so a reload there answered
// with the backend's 404 instead of the app.
const base = (process.env.VITE_BASE || '/').replace(/\/?$/, '/')
const prefixed = (path: string) => (base === '/' ? path : `${base.slice(0, -1)}${path}`)
const strip = base === '/' ? undefined : (p: string) => p.slice(base.length - 1)

// Prod forwards /next to the dev stack itself, rather than asking the reverse
// proxy in front of Jarvis to learn a second route. One origin, one login, and
// nothing to change upstream when the preview stack moves or goes away — it
// 502s here instead, which is the truth. Empty on the next stack itself, so it
// never proxies to itself.
const nextUrl = base === '/' ? process.env.NEXT_FRONTEND_URL : undefined
const nextProxy = nextUrl ? { '/next': { target: nextUrl, ws: true } } : {}

// The HMR socket travels browser → reverse proxy → prod frontend → here, so the
// port the client should dial is the page's, not this container's. Vite only
// gets that right on its own when it isn't proxied; NEXT_HMR_CLIENT_PORT=443
// is the override for an https host.
const hmrClientPort = Number(process.env.VITE_HMR_CLIENT_PORT) || undefined

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  build: {
    watch: process.argv.includes('--watch') ? {
      chokidar: { usePolling: true, interval: 1000 },
    } : null,
  },
  // NB: no '/internal' proxy — that API is backend-internal (connector secrets,
  // cron/webhook upserts) and must never be reachable from a browser.
  server: {
    port: 5173,
    allowedHosts: true,
    hmr: hmrClientPort ? { clientPort: hmrClientPort } : undefined,
    proxy: {
      ...nextProxy,
      // ws: the browser page proxies a websocket (the VNC stream behind
      // Settings → Browser). Vite's string shorthand does not enable upgrade
      // forwarding, so without this the handshake is dropped here — the page
      // loads and then sits forever on "connecting".
      [prefixed('/api/')]: { target: backendUrl, ws: true, rewrite: strip },
      [prefixed('/health')]: { target: backendUrl, rewrite: strip },
    },
  },
  preview: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      ...nextProxy,
      '/api/': { target: backendUrl, ws: true },
      '/health': backendUrl,
    },
  },
})
