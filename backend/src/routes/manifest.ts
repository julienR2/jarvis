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
      // Dark on purpose, even though the app defaults to the light palette.
      // Android bakes this colour into the WebAPK at install time and paints the
      // status bar with it; since Android 15 made `setStatusBarColor` a no-op,
      // Chrome can no longer recolor that bar when the in-app theme changes.
      // Only the icon tint still follows the runtime `<meta name="theme-color">`,
      // so a light bar under a dark theme rendered white icons on beige. Pinning
      // both to the dark value keeps the bar legible in either theme (see the
      // matching pin in frontend/index.html and useTheme.tsx).
      theme_color: '#211f1c',
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
