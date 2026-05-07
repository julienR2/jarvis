import type { FastifyInstance } from 'fastify'
import { getDb } from '../db.js'

// Android supports up to 4 static shortcuts on most launchers.
const MAX_SHORTCUTS = 4

type MiniAppRow = { id: string; title: string | null }

// Extract the first emoji character from a string.
function extractEmoji(str: string): string | null {
  const match = str.match(/\p{Extended_Pictographic}/u)
  return match ? match[0] : null
}

// Return a Twemoji CDN URL for the given emoji, or null if conversion fails.
// Twemoji names files by lowercase hex codepoints joined with dashes,
// excluding the variation selector FE0F for standalone emoji.
function emojiIconUrl(emoji: string): string | null {
  const points = [...emoji]
    .map((c) => c.codePointAt(0)!.toString(16).toLowerCase())
    .filter((cp) => cp !== 'fe0f')

  if (points.length === 0) return null
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@v14.0.2/assets/72x72/${points.join('-')}.png`
}

export async function manifestRoutes(app: FastifyInstance) {
  app.get('/manifest.webmanifest', async (_req, reply) => {
    const miniApps = getDb()
      .prepare(
        `SELECT id, title FROM conversations
         WHERE mini_app_path IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(MAX_SHORTCUTS) as MiniAppRow[]

    const shortcuts = miniApps.map((m) => {
      const name = m.title?.trim() || 'Mini app'
      const emoji = extractEmoji(name)
      const cdnUrl = emoji ? emojiIconUrl(emoji) : null

      const icons = cdnUrl
        ? [{ src: cdnUrl, sizes: '72x72', type: 'image/png' }]
        : [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }]

      return {
        name,
        short_name: name.slice(0, 12),
        description: name,
        url: `/c/${m.id}`,
        icons,
      }
    })

    const manifest = {
      name: 'Jarvis',
      short_name: 'Jarvis',
      description: 'AI assistant powered by Claude',
      start_url: '/',
      display: 'standalone',
      orientation: 'natural',
      background_color: '#faf9f7',
      theme_color: '#f3f1ed',
      icons: [
        { src: '/icons/icon-48.png', sizes: '48x48', type: 'image/png' },
        { src: '/icons/icon-72.png', sizes: '72x72', type: 'image/png' },
        { src: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
        { src: '/icons/icon-144.png', sizes: '144x144', type: 'image/png' },
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      share_target: {
        action: '/share',
        method: 'POST',
        enctype: 'multipart/form-data',
        params: {
          title: 'title',
          text: 'text',
          url: 'url',
          files: [
            {
              name: 'files',
              accept: [
                'image/*',
                'application/pdf',
                'text/*',
                'video/*',
                'audio/*',
                '.doc',
                '.docx',
                '.xls',
                '.xlsx',
                '.csv',
                '.json',
              ],
            },
          ],
        },
      },
      shortcuts,
    }

    return reply
      .header('Content-Type', 'application/manifest+json')
      .header('Cache-Control', 'no-cache')
      .send(manifest)
  })
}
