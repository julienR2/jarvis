import type { FastifyRequest } from 'fastify'

/**
 * Pull a bearer token off a request, from any of the three places a browser can
 * put one.
 *
 * The header is the norm, but it isn't always available: `<img src>`, `<a href>`
 * and EventSource can't set headers. Those paths carry the token in the query
 * string, or rely on the session cookie set by POST /api/auth/session-cookie —
 * which is what lets content embedded inside chat and generated apps stay
 * authenticated without every URL carrying a credential.
 */
export function extractRequestToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  const q = (req.query as { token?: unknown } | undefined)?.token
  if (typeof q === 'string' && q) return q

  return readCookie(req, 'jarvis_session') ?? readCookie(req, 'jarvis_app')
}

export function readCookie(req: FastifyRequest, name: string): string | null {
  const cookie = req.headers.cookie
  if (!cookie) return null
  // Cookie values here are JWTs and opaque tokens: no ';' or whitespace.
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1] : null
}

export const SESSION_COOKIE = 'jarvis_session'
