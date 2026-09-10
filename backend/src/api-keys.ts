import { createHash, randomBytes } from 'crypto'
import { getDb } from './db.js'
import type { ApiKeyRow, UserRow } from './types.js'

/**
 * API keys: a second way to present the *same* account to the *same* API.
 *
 * Deliberately not a parallel API surface. A key is accepted anywhere a session
 * JWT is (see `authenticateRequest`), so anything the web UI can do — start a
 * conversation, read messages, trigger a cron — a script can do with one header
 * and no login round-trip. The alternative, a hand-maintained subset of routes,
 * is exactly the kind of thing that drifts away from the UI it mirrors.
 *
 * What a key deliberately cannot do is manage keys: minting is reserved for a
 * real session, so a leaked key can be revoked and cannot mint a replacement
 * first (see routes/api-keys.ts).
 */

/** Recognisable at a glance in logs and .env files, and greppable when leaked. */
const PREFIX = 'jarvis_sk_'

/** How much of the key the UI is allowed to show — the tag, plus enough to
 *  distinguish keys, but far too little to brute-force the rest. */
const HINT_LEN = PREFIX.length + 6

export function isApiKey(token: string): boolean {
  return token.startsWith(PREFIX)
}

export function generateApiKey(): string {
  return PREFIX + randomBytes(32).toString('base64url')
}

/**
 * Plain SHA-256, not bcrypt.
 *
 * bcrypt exists to slow down guessing of low-entropy human passwords. A key is
 * 256 random bits, so there is nothing to guess, and a deliberately slow hash
 * would land on every single authenticated request.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function keyHint(key: string): string {
  return `${key.slice(0, HINT_LEN)}…`
}

/**
 * Resolve a raw key to the user it authenticates, or null.
 *
 * Looks up by hash, so an invalid key touches an index and stops — no scan, and
 * no comparison against a stored secret that timing could pick apart.
 */
export function userForApiKey(key: string): UserRow | null {
  if (!isApiKey(key)) return null
  const db = getDb()
  const row = db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    .get(hashApiKey(key)) as ApiKeyRow | undefined
  if (!row) return null

  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(row.user_id) as UserRow | undefined
  if (!user) return null

  // Best-effort "last used": the page that lists keys is the only way to spot a
  // key still in use somewhere you've forgotten about. Written on every call,
  // which is one cheap indexed UPDATE and the reason the timestamp is honest.
  db.prepare('UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?').run(row.id)

  return user
}
