import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The generic `backend` alias is ambiguous when several Jarvis clones share a
// Docker network (each stack's service gets the same alias, and Docker DNS
// round-robins across them). Multi-instance setups pin BACKEND_URL to the
// clone's container name in docker-compose.override.yml.
const backendUrl = process.env.BACKEND_URL || 'http://backend:3005'

export default defineConfig({
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
    proxy: {
      '/api': backendUrl,
      '/health': backendUrl,
    },
  },
  preview: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': backendUrl,
      '/health': backendUrl,
    },
  },
})
