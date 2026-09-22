import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The generic `backend` alias is ambiguous when several Jarvis clones share a
// Docker network (each stack's service gets the same alias, and Docker DNS
// round-robins across them). Multi-instance setups pin BACKEND_URL to the
// clone's container name in docker-compose.override.yml.
const backendUrl = process.env.BACKEND_URL || 'http://backend:3005'

// The e2e suite starts a dev server from inside the ENGINE container, where
// frontend/node_modules is mounted read-only — vite cannot write its dependency
// scan into the default node_modules/.vite there. VITE_CACHE_DIR sends it to a
// scratch directory instead. Unset everywhere else, which keeps the default.
const cacheDir = process.env.VITE_CACHE_DIR || undefined

// The proxy key is `/api/` WITH the trailing slash: vite matches by prefix, and
// a bare `/api` also captured the `/api-keys` page, so a reload there answered
// with the backend's 404 instead of the app.
//
// NB: no '/internal' proxy — that API is backend-internal (connector secrets,
// cron/webhook upserts) and must never be reachable from a browser.
//
// ws: the browser page proxies a websocket (the VNC stream behind Settings →
// Browser). Vite's string shorthand does not enable upgrade forwarding, so
// without this the handshake is dropped here — the page loads and then sits
// forever on "connecting".
const proxy = {
  '/api/': { target: backendUrl, ws: true },
  '/health': { target: backendUrl },
}

export default defineConfig({
  cacheDir,
  plugins: [react(), tailwindcss()],
  build: {
    watch: process.argv.includes('--watch') ? {
      chokidar: { usePolling: true, interval: 1000 },
    } : null,
  },
  server: { port: 5173, allowedHosts: true, proxy },
  preview: { port: 5173, allowedHosts: true, proxy },
})
