import type { FastifyRequest } from 'fastify'
import { userForApiKey } from './api-keys.js'
import { getDb } from './db.js'

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

/**
 * The identity a request carries, from either credential the account accepts.
 *
 * `via` is not decoration: key management refuses anything but a real session,
 * so a stolen key cannot be used to mint a fresh one before you revoke it.
 */
export interface Identity {
  id: number
  email: string
  via: 'session' | 'api-key'
}

/**
 * Attach the identity behind an API key to the request, mirroring what
 * `req.jwtVerify()` does for a session, so downstream handlers reading
 * `req.user` cannot tell the two apart — which is the whole point.
 */
export function applyApiKey(req: FastifyRequest, token: string | null): Identity | null {
  if (!token) return null
  const user = userForApiKey(token)
  if (!user) return null
  const identity: Identity = { id: user.id, email: user.email, via: 'api-key' }
  ;(req as FastifyRequest & { user: Identity }).user = identity
  return identity
}

/**
 * A valid session JWT whose account exists on THIS instance.
 *
 * Signature alone is not enough: the `next` stack shares the signing secret so
 * the owner's session carries over to it, and that cuts both ways — a token
 * minted over there for an account that exists only over there (the e2e user)
 * must not open this instance. Rejecting unknown ids keeps the sharing exactly
 * as wide as the accounts the two databases have in common.
 */
export async function verifySession(req: FastifyRequest): Promise<void> {
  await req.jwtVerify()
  const id = (req.user as { id?: unknown } | undefined)?.id
  if (typeof id !== 'number' || !getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(id)) {
    throw new Error('session user unknown here')
  }
}
