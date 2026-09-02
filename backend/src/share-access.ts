/**
 * Letting a share link drive the real conversation endpoints.
 *
 * The shared view is the normal chat UI with the sidebar and actions removed,
 * so it calls the same endpoints the owner's UI does. Rather than maintain a
 * parallel read-only API that drifts, a share token authenticates those
 * endpoints directly — but only for its own conversation, and only for the
 * handful of operations the stripped UI actually needs.
 *
 * The allowlist is here, in one place, so what a link can reach is a single
 * thing to audit rather than a property spread across route definitions.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb } from './db.js'
import { secureEquals } from './security.js'
import { extractRequestToken } from './request-auth.js'
import type { ConvRow } from './types.js'

export interface ShareAccess {
  conv: ConvRow
  mode: 'read' | 'write'
}

/** Resolve a share token to its conversation, or null. Constant-time compare. */
export function resolveShareToken(token: string | null): ShareAccess | null {
  if (!token) return null
  const row = getDb()
    .prepare('SELECT * FROM conversations WHERE share_token IS NOT NULL AND share_mode IS NOT NULL')
    .all() as ConvRow[]
  for (const conv of row) {
    if (conv.share_token && secureEquals(token, conv.share_token)) {
      return { conv, mode: conv.share_mode as 'read' | 'write' }
    }
  }
  return null
}

/** The share access carried by this request, if any. */
export function shareAccessFor(req: FastifyRequest): ShareAccess | null {
  return resolveShareToken(extractRequestToken(req))
}

/**
 * Accept either a logged-in owner or a share link.
 *
 * `need` is the capability the route requires: 'read' routes serve any share,
 * 'write' routes only an editable one. A share is additionally confined to the
 * conversation it belongs to — the :id in the URL must be its own, so one link
 * can never be pointed at another conversation.
 */
export function ownerOrShare(app: FastifyInstance, need: 'read' | 'write') {
  return async function (req: any, reply: any) {
    // Owner first: a logged-in user keeps full rights on their own instance.
    try {
      await req.jwtVerify()
      return
    } catch {
      /* not a session — fall through to share links */
    }

    const access = shareAccessFor(req)
    if (!access) return reply.code(401).send({ error: 'Unauthorized' })

    const id = (req.params as { id?: string })?.id
    if (id && id !== access.conv.id) {
      return reply.code(403).send({ error: 'This link does not open that conversation' })
    }
    if (need === 'write' && access.mode !== 'write') {
      return reply.code(403).send({ error: 'This link is read-only' })
    }

    // Marks the request as share-driven so handlers can withhold anything the
    // stripped view has no business seeing.
    req.share = access
  }
}
