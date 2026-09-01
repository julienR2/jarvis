import { randomBytes } from 'crypto'
import { getDb } from './db.js'
import { secureEquals } from './security.js'
import type { ConvRow } from './types.js'

// Per-conversation capability for serving that conversation's generated app.
//
// Apps used to be gated on the user's login JWT passed in the URL, which meant
// the "open in new tab" link handed out a 30-day credential for the entire API,
// and any valid token opened any app. A share token is scoped to one
// conversation, carries no account rights, and can be rotated on its own to
// revoke a link that has been shared too widely.
//
// It is still a bearer secret in a URL: anyone holding the link can load the
// app. That is the intent of a share link — the point is that it can do nothing
// else, and can be revoked without disturbing the user's session.

export function generateAppToken(): string {
  return randomBytes(24).toString('base64url')
}

/** The conversation's token, minted on first use so existing apps get one. */
export function ensureAppToken(conversationId: string): string | null {
  const db = getDb()
  const row = db
    .prepare('SELECT app_token FROM conversations WHERE id = ?')
    .get(conversationId) as { app_token: string | null } | undefined
  if (!row) return null
  if (row.app_token) return row.app_token

  const token = generateAppToken()
  db.prepare('UPDATE conversations SET app_token = ? WHERE id = ?').run(
    token,
    conversationId,
  )
  return token
}

/** Replace the token, invalidating every link previously handed out. */
export function rotateAppToken(conversationId: string): string | null {
  const db = getDb()
  const exists = db
    .prepare('SELECT id FROM conversations WHERE id = ?')
    .get(conversationId)
  if (!exists) return null

  const token = generateAppToken()
  db.prepare('UPDATE conversations SET app_token = ? WHERE id = ?').run(
    token,
    conversationId,
  )
  return token
}

/**
 * Resolve an app URL slug + token to the conversation it unlocks.
 *
 * The slug is the directory under apps/, which is NOT always the conversation
 * id: apps created by name have paths like `apps/bookmarks`, while newer ones
 * use the id. So resolve on app_path, falling back to the id for safety.
 *
 * The token is then compared in constant time against that one conversation's
 * token — looking the token up directly would leak, through timing, whether a
 * guessed value exists.
 */
export function conversationForAppToken(
  slug: string,
  token: string,
): ConvRow | null {
  const db = getDb()
  const row = (db
    .prepare('SELECT * FROM conversations WHERE app_path = ?')
    .get(`apps/${slug}`) ??
    db.prepare('SELECT * FROM conversations WHERE id = ?').get(slug)) as
    | ConvRow
    | undefined
  if (!row) return null
  const stored = (row as ConvRow & { app_token?: string | null }).app_token
  if (!stored) return null
  return secureEquals(token, stored) ? row : null
}
