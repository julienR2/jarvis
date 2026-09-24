import { getDb } from './db.js'
import { conversationFiles } from './app-archive.js'
import { emitGlobalEvent } from './sse.js'

/**
 * How long a chat may sit empty before it is swept. Long enough that nobody
 * loses a chat they opened and are still typing into; short enough that "open
 * a chat, change your mind" leaves nothing behind for long.
 */
const GRACE_S = 60 * 60
const EVERY_MS = 10 * 60 * 1000

/**
 * Delete chats that never got a message.
 *
 * Opening a chat and walking away used to leave an "Untitled" row behind each
 * time. A chat only counts as empty when nothing points at it or lives in it:
 * no message, no routine posting there, no run, no app, no share link, no
 * question waiting, and no uploaded file (attached, then never sent). Anything
 * else is somebody's, even with an empty transcript.
 */
export function sweepEmptyChats(): string[] {
  const db = getDb()
  const candidates = db
    .prepare(
      `SELECT c.id, c.app_path FROM conversations c
        WHERE c.created_at < unixepoch() - ?
          AND c.app_path IS NULL AND c.share_token IS NULL AND c.pending_question IS NULL
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM crons WHERE conversation_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM webhooks WHERE conversation_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM runs WHERE conversation_id = c.id)`,
    )
    .all(GRACE_S) as { id: string; app_path: string | null }[]

  const swept = candidates
    .filter((c) => conversationFiles(c.id, c.app_path).uploads === 0)
    .map((c) => c.id)
  if (swept.length === 0) return swept

  const del = db.prepare('DELETE FROM conversations WHERE id = ?')
  db.transaction(() => { for (const id of swept) del.run(id) })()
  console.log(`[empty-chats] swept ${swept.length} empty chat(s)`)
  // Open tabs drop them from the sidebar without a reload.
  emitGlobalEvent({ type: 'conversations_removed', ids: swept })
  return swept
}

export function startEmptyChatSweep(): void {
  sweepEmptyChats()
  setInterval(sweepEmptyChats, EVERY_MS).unref()
}
