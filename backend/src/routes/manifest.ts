import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb } from '../db.js'
import { readCookie, SESSION_COOKIE } from '../request-auth.js'
import { listShortcuts } from '../shortcuts.js'

/**
 * The manifest is public — a browser fetches it before anyone logs in — but
 * the shortcuts are chat titles, so they are only listed for a signed-in
 * session. index.html links it with `crossorigin="use-credentials"`, without
 * which the browser leaves the session cookie off this request.
 */
async function signedIn(app: FastifyInstance, req: FastifyRequest): Promise<boolean> {
  const token = readCookie(req, SESSION_COOKIE)
  if (!token) return false
  try {
    const { id } = app.jwt.verify<{ id?: unknown }>(token)
    return typeof id === 'number' && !!getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(id)
  } catch {
    return false
  }
}

export async function manifestRoutes(app: FastifyInstance) {
  app.get('/manifest.webmanifest', async (req, reply) => {
    // Chats chosen from their menu (backend/src/shortcuts.ts). Android shows
    // them on a long-press of the installed icon, and each can be dragged onto
    // the home screen. Chrome re-reads the manifest only now and then (on a
    // launch, about once a day), so a new one takes a while to show up.
    // They open the chat on whatever pane it was last left showing.
    const shortcuts = (await signedIn(app, req))
      ? listShortcuts().map((c) => ({
          name: c.title,
          short_name: c.title,
          url: `/c/${c.id}`,
          icons: [
            { src: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          ],
        }))
      : []
    const manifest = {
      name: 'Jarvis',
      short_name: 'Jarvis',
      description: 'AI assistant powered by Claude',
      // `id` spelled out at what it already defaulted to (start_url), so the
      // installed app keeps its identity if start_url ever changes. `scope`
      // is the whole origin: /c/<id> — the link other apps open — has to be
      // inside it for the installed app to capture it at all.
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      // Chromium (desktop, Android): a link into the app opens in the app,
      // and reuses its open window rather than stacking new ones. Focused, not
      // navigated: `navigate-existing` reloads the window from scratch, while
      // `focus-existing` hands the URL to the page's launchQueue and the
      // router switches chat in place (frontend/src/hooks/useLaunchQueue.ts).
      // `auto` is for browsers that know neither. Safari and Firefox ignore
      // both members. No custom URL scheme: https links are the contract.
      launch_handler: { client_mode: ['focus-existing', 'auto'] },
      handle_links: 'preferred',
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
      ...(shortcuts.length ? { shortcuts } : {}),
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
