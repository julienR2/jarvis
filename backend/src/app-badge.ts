import { getDb } from './db.js'
import { emitGlobalEvent } from './sse.js'

/** Past this it is not a count anyone reads off a badge. */
const MAX_BADGE = 99_999

/**
 * A chat's badge, as its app sets it: the count the app says matters — an
 * inbox's mail still to deal with, say — shown on the chat in place of its
 * unread replies, and added into the app icon's total.
 *
 * Two ways in, the same write: `jarvis.setBadge(n)` from the app while it is
 * open (routes/app-bridge.ts), and the internal API for a routine or the agent
 * keeping it right while nobody has the app open (routes/internal.ts).
 *
 * `null`, 0 or less clears it. Returns an error message, or null when done.
 */
export function setAppBadge(conversationId: string, raw: unknown): string | null {
  if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw))) {
    return 'count must be a number, or null to clear it'
  }
  const count = raw === null || raw <= 0 ? null : Math.min(Math.floor(raw), MAX_BADGE)
  const row = getDb().prepare('SELECT app_badge FROM conversations WHERE id = ?').get(conversationId) as
    | { app_badge: number | null }
    | undefined
  if (!row) return 'Conversation not found'
  // An app may well set it on every render: only a change reloads the lists.
  if (row.app_badge === count) return null
  getDb().prepare('UPDATE conversations SET app_badge = ? WHERE id = ?').run(count, conversationId)
  emitGlobalEvent({ type: 'conversation_changed', conversation_id: conversationId })
  return null
}
