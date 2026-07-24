import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
      '/api': 'http://backend:3005',
      '/health': 'http://backend:3005',
    },
  },
  preview: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': 'http://backend:3005',
      '/health': 'http://backend:3005',
    },
  },
})
