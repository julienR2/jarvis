import type { FastifyInstance } from 'fastify'

export async function manifestRoutes(app: FastifyInstance) {
  app.get('/manifest.webmanifest', async (_req, reply) => {
    // No `shortcuts` member: launcher shortcuts used to be generated from pinned
    // conversations, which no longer exist (pinning became sidebar sections) and
    // which nobody used.
    const manifest = {
      name: 'Jarvis',
      short_name: 'Jarvis',
      description: 'AI assistant powered by Claude',
      start_url: '/',
      display: 'standalone',
      // No `orientation` member on purpose: any value (even 'any') locks the PWA
      // and overrides the device rotation lock. Omitting it lets Android decide —
      // rotation lock is respected, with the usual manual rotate button.
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
              accept: ['*/*'],
            },
          ],
        },
      },
    }

    return reply
      .header('Content-Type', 'application/manifest+json')
      .header('Cache-Control', 'no-cache')
      .send(manifest)
  })
}
