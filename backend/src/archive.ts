// Archive — how a conversation goes away.
//
// Nothing is deleted on the spot. Archiving puts a conversation away with
// everything under it — its threads, side chats and routines alike, stamped
// with the same moment so they come back together — and pauses the routines
// that run in them. The Archive page lists what was put away and brings it
// back. A week later it is deleted for good, with its files: uploads, its app.

import { getDb } from './db.js'
import { emitGlobalEvent } from './sse.js'
import { purgeConversationFiles } from './app-archive.js'
import { rescheduleAll } from './crons.js'

/** How long an archived conversation is kept before it is deleted for good. */
export const ARCHIVE_KEEP_S = 7 * 24 * 3600
const EVERY_MS = 60 * 60 * 1000

/** The conversation and every one under it, however deep. */
function subtree(id: string): string[] {
  return (getDb()
    .prepare(
      `WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT c.id FROM conversations c JOIN t ON c.parent_id = t.id)
       SELECT id FROM t`,
    )
    .all(id) as { id: string }[]).map((r) => r.id)
}

const marks = (ids: string[]) => ids.map(() => '?').join(',')

/**
 * Put a conversation away, with everything under it that is not away already,
 * and pause the routines running in them (remembering which, so restoring
 * resumes those and not one paused by hand). False when it is unknown.
 */
export function archiveConversation(id: string): boolean {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) return false
  const ids = subtree(id)
  const now = Math.floor(Date.now() / 1000)
  let paused = 0
  db.transaction(() => {
    db.prepare(`UPDATE conversations SET archived_at = ? WHERE id IN (${marks(ids)}) AND (archived_at IS NULL OR id = ?)`).run(now, ...ids, id)
    for (const table of ['crons', 'webhooks']) {
      paused += db
        .prepare(`UPDATE ${table} SET enabled = 0, archived_pause = 1 WHERE enabled = 1 AND thread_id IN (${marks(ids)})`)
        .run(...ids).changes
    }
  })()
  if (paused) rescheduleAll()
  for (const c of ids) emitGlobalEvent({ type: 'conversation_changed', conversation_id: c })
  return true
}

/**
 * Bring a conversation back, with what was put away with it, and resume the
 * routines archiving paused. The chats above it come back too — one under an
 * archived chat would have nowhere to show — but not their other threads.
 */
export function unarchiveConversation(id: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT archived_at, parent_id FROM conversations WHERE id = ?').get(id) as
    | { archived_at: number | null; parent_id: string | null }
    | undefined
  if (!row) return false
  const restored = row.archived_at === null
    ? []
    : subtree(id).filter((c) => c === id || (db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(c) as { archived_at: number | null }).archived_at === row.archived_at)
  // The archived chats above, each on its own.
  const seen = new Set<string>([id])
  for (let p = row.parent_id; p && !seen.has(p);) {
    seen.add(p)
    const up = db.prepare('SELECT archived_at, parent_id FROM conversations WHERE id = ?').get(p) as
      | { archived_at: number | null; parent_id: string | null }
      | undefined
    if (!up) break
    if (up.archived_at !== null) restored.push(p)
    p = up.parent_id
  }
  if (!restored.length) return true
  let resumed = 0
  db.transaction(() => {
    db.prepare(`UPDATE conversations SET archived_at = NULL WHERE id IN (${marks(restored)})`).run(...restored)
    for (const table of ['crons', 'webhooks']) {
      resumed += db
        .prepare(`UPDATE ${table} SET enabled = 1, archived_pause = 0 WHERE archived_pause = 1 AND thread_id IN (${marks(restored)})`)
        .run(...restored).changes
    }
  })()
  if (resumed) rescheduleAll()
  for (const c of restored) emitGlobalEvent({ type: 'conversation_changed', conversation_id: c })
  return true
}

/**
 * Delete a conversation for good, with everything under it: their messages,
 * files and the routines that run in them. What the Archive does after a week
 * — and there (`onlyArchived`) a thread brought back meanwhile is spared: it
 * moves to the top level instead.
 */
export function purgeConversation(id: string, onlyArchived = false): string[] {
  const db = getDb()
  const ids = onlyArchived
    ? subtree(id).filter((c) => c === id || (db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(c) as { archived_at: number | null }).archived_at !== null)
    : subtree(id)
  const rows = db.prepare(`SELECT id, app_path FROM conversations WHERE id IN (${marks(ids)})`).all(...ids) as
    { id: string; app_path: string | null }[]
  let routines = 0
  db.transaction(() => {
    for (const table of ['crons', 'webhooks']) {
      routines += db.prepare(`DELETE FROM ${table} WHERE thread_id IN (${marks(ids)})`).run(...ids).changes
    }
    db.prepare(`DELETE FROM conversations WHERE id IN (${marks(ids)})`).run(...ids)
  })()
  for (const r of rows) purgeConversationFiles(r.id, r.app_path)
  if (routines) rescheduleAll()
  emitGlobalEvent({ type: 'conversations_removed', ids })
  return ids
}

/** Delete what has been in the Archive for more than a week. */
export function purgeExpiredArchive(): number {
  const expired = getDb()
    .prepare('SELECT id FROM conversations WHERE archived_at IS NOT NULL AND archived_at < unixepoch() - ?')
    .all(ARCHIVE_KEEP_S) as { id: string }[]
  let n = 0
  for (const { id } of expired) {
    // Gone already, with a parent purged just before.
    if (!getDb().prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) continue
    n += purgeConversation(id, true).length
  }
  if (n) console.log(`[archive] deleted ${n} conversation(s) archived over a week ago`)
  return n
}

export function startArchivePurge(): void {
  purgeExpiredArchive()
  setInterval(purgeExpiredArchive, EVERY_MS).unref()
}
