/**
 * Authenticated passthrough to the headful browser's KasmVNC interface.
 *
 * The browser container publishes nothing to the world; it is reachable only on
 * the compose network, and this proxy is the single way in. That is deliberate:
 * it means the browser inherits Jarvis's own login instead of needing a second
 * password, and there is no second thing to remember to secure.
 *
 * Disabled unless BROWSER_URL is set, so an instance without the optional
 * browser profile running doesn't advertise a page that can't work.
 */
import type { FastifyInstance } from 'fastify'
import proxy from '@fastify/http-proxy'
import { extractRequestToken } from '../request-auth.js'

export const BROWSER_URL = process.env.BROWSER_URL || ''

// KasmVNC has its own basic-auth login. The whole point of proxying is that you
// shouldn't meet a second password, so the proxy answers that challenge itself
// with the credentials compose gave the container. They never reach the browser.
const BROWSER_USER = process.env.BROWSER_USER || 'jarvis'
const BROWSER_PASSWORD = process.env.BROWSER_PASSWORD || 'jarvis'
const upstreamAuth =
  'Basic ' + Buffer.from(`${BROWSER_USER}:${BROWSER_PASSWORD}`).toString('base64')

/**
 * Pull the session token off a raw upgrade request.
 *
 * This runs before Fastify has parsed anything, so cookies and query string are
 * read off the raw headers/url rather than a decorated request.
 */
function tokenFromUpgrade(req: {
  headers: Record<string, string | undefined>
  url?: string
}): string | null {
  const cookie = req.headers.cookie
  if (cookie) {
    const m = cookie.match(/(?:^|;\s*)jarvis_session=([^;]+)/)
    if (m) return m[1]
  }
  // Fallback for clients that can't send the cookie; the URL is same-origin so
  // this never leaves the instance.
  const q = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : ''
  const token = new URLSearchParams(q).get('token')
  return token || null
}

export async function browserRoutes(app: FastifyInstance) {
  // Always present, so the UI can explain how to turn the browser on rather
  // than showing a dead page.
  app.get('/api/browser-status', { onRequest: [app.authenticate] }, async () => ({
    enabled: !!BROWSER_URL,
  }))

  if (!BROWSER_URL) return

  await app.register(proxy, {
    upstream: BROWSER_URL,
    prefix: '/api/browser',
    rewritePrefix: '',
    // KasmVNC streams the framebuffer over a websocket.
    websocket: true,
    // Static VNC assets are numerous and chatty; the global API limit isn't the
    // right shape for them, and the route is authenticated anyway.
    config: { rateLimit: false },
    replyOptions: {
      rewriteRequestHeaders: (_req, headers) => ({
        ...headers,
        authorization: upstreamAuth,
      }),
    },
    // The websocket carries the actual VNC stream, and it is a separate path
    // from the HTTP proxying above — replyOptions does not apply to it.
    //
    // Upstream auth has to be repeated here, or KasmVNC 401s the upgrade and
    // the client sits on a black screen saying "connecting".
    wsClientOptions: {
      headers: { authorization: upstreamAuth },
    },
    // And our own auth has to be re-checked here, because `preHandler` does not
    // run for upgrade requests. Without this the websocket would be an
    // unauthenticated way into the browser session even though the page in
    // front of it is gated — the worst possible combination.
    wsServerOptions: {
      verifyClient: (
        info: { req: { headers: Record<string, string | undefined>; url?: string } },
        next: (ok: boolean, code?: number, message?: string) => void,
      ) => {
        const token = tokenFromUpgrade(info.req)
        if (!token) return next(false, 401, 'Unauthorized')
        app.jwt.verify(token, (err: unknown) => next(!err, 401, 'Unauthorized'))
      },
    },
    preHandler: async (req, reply) => {
      const token = extractRequestToken(req)
      if (!token) return reply.code(401).send({ error: 'Unauthorized' })
      try {
        await app.jwt.verify(token)
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
    },
  })

  console.log(`[browser] proxying /api/browser -> ${BROWSER_URL}`)
}
