/**
 * Private conversations: the ones a local model has spoken in.
 *
 * The point of the Local provider is that what is said to it stays on this
 * machine. A conversation's content can leave in more ways than its own turns,
 * so the rule is about the conversation, not the message: once a local model
 * has run in it — or it is set to one — it is private for good, and
 *
 *   - its turns only ever run on a local model: never Anthropic, never the
 *     gateway, titles included (processMessage, titles.ts);
 *   - the agent can't see it: it is missing from the agent's conversation
 *     list, search and read-back API (routes/internal.ts), from topic
 *     consolidation, and from the thread/chat activity digests other chats'
 *     prompts carry (threads.ts);
 *   - its uploads live outside the agent's workspace (uploads.ts);
 *   - a thread opened from it runs on the local model too;
 *   - its push notifications carry no text from it (push payloads go through
 *     the browser vendor's push service, encrypted, but still).
 *
 * Messages, not only the conversation's `model` column, decide: the column is
 * just where the composer starts next time, and switching it back to Claude
 * must not make the earlier local turns readable.
 */
import { getDb } from './db.js'
import { isLocalModel, LOCAL_PREFIX } from './local-llm.js'

const LIKE = `'${LOCAL_PREFIX}%'`

/** SQL condition: conversation row `alias` is private. */
export function privateSql(alias: string): string {
  return `(${alias}.model LIKE ${LIKE} OR EXISTS (SELECT 1 FROM messages pm WHERE pm.conversation_id = ${alias}.id AND pm.model LIKE ${LIKE}))`
}

export function isPrivateConversation(id: string): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM conversations c WHERE c.id = ? AND ${privateSql('c')}`)
    .get(id)
}

/**
 * The local model a private conversation runs on when a message names none (a
 * routine, a share, the agent's relay): the one it is set to, else the one that
 * spoke last. Null for a conversation that isn't private.
 */
export function localModelOf(id: string): string | null {
  const conv = getDb().prepare('SELECT model FROM conversations WHERE id = ?').get(id) as { model: string | null } | undefined
  if (isLocalModel(conv?.model)) return conv!.model as string
  const row = getDb()
    .prepare(
      `SELECT model FROM messages WHERE conversation_id = ? AND model LIKE ${LIKE}
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(id) as { model: string } | undefined
  return row?.model ?? null
}

