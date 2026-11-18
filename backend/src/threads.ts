// Threads — conversations under other conversations, and where routines run.
//
// Every conversation is the same thing. One may hang under another
// (`parent_id`), and may have been opened on one of its passages
// (`parent_message_id`); the sidebar shows it nested under its parent while it
// has something for you, and the parent's # list keeps all of them. Nesting
// goes as deep as it goes: a thread can have threads.
//
// A routine (cron or webhook) runs in a conversation of its own — the
// routine's `thread_id` — which may hang under a chat: the routine's
// `conversation_id`, mirrored as that conversation's `parent_id`.
//
// Nothing a conversation does is written into its parent. Each counts its own
// unread, asks its own questions and pushes under its own notify mode. A
// parent hears what its threads did in its prompt (threadActivityPrompt), and
// a thread what its parent said (parentActivityPrompt) — never in the
// transcript.

import { getDb, uuid } from './db.js'
import { emitConversationEvent, emitGlobalEvent } from './sse.js'
import { pushForConversation } from './push.js'
import { isPrivateConversation } from './private.js'
import { UNTITLED } from './titles.js'
import type { ConvRow, RunRow } from './types.js'

export type RoutineTable = 'crons' | 'webhooks'

interface RoutineRef {
  id: string
  name: string
  conversation_id: string | null
  thread_id: string | null
}

function getConv(id: string | null | undefined): ConvRow | undefined {
  if (!id) return undefined
  return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConvRow | undefined
}

/** True when `parentId` is `id` itself or one of its descendants: hanging `id` there would close a loop. */
export function wouldCycle(id: string, parentId: string | null): boolean {
  let cursor = parentId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    if (cursor === id) return true
    seen.add(cursor)
    cursor = (getDb().prepare('SELECT parent_id FROM conversations WHERE id = ?').get(cursor) as { parent_id: string | null } | undefined)?.parent_id ?? null
  }
  return false
}

/**
 * Hang a conversation under another, or at the top (null). The routine that
 * runs in it, if any, follows — its `conversation_id` is the same fact — so
 * its next fire does not put it back. False when the parent is unknown or
 * would close a loop.
 */
export function setParent(id: string, parentId: string | null): boolean {
  const db = getDb()
  if (parentId && !getConv(parentId)) return false
  if (wouldCycle(id, parentId)) return false
  // Hung under a chat, it is no longer filed on its own: it sits where its parent is.
  db.prepare(`UPDATE conversations SET parent_id = ?${parentId ? ', section_id = NULL' : ''} WHERE id = ?`).run(parentId, id)
  for (const table of ['crons', 'webhooks']) {
    db.prepare(`UPDATE ${table} SET conversation_id = ? WHERE thread_id = ?`).run(parentId, id)
  }
  if (parentId === null) db.prepare('UPDATE conversations SET parent_message_id = NULL WHERE id = ?').run(id)
  emitGlobalEvent({ type: 'conversation_changed', conversation_id: id })
  return true
}

/**
 * The routine's conversation, opened on first use — or again after it was
 * deleted. Its parent is re-read from the routine on every fire, so
 * re-attaching a routine takes effect on its next run.
 */
export function ensureThread(
  table: RoutineTable,
  entry: RoutineRef,
  notify: ConvRow['notify'] = 'auto',
): ConvRow {
  const parentId = getConv(entry.conversation_id)?.id ?? null
  const existing = getConv(entry.thread_id)
  if (existing) {
    if (existing.parent_id !== parentId && !wouldCycle(existing.id, parentId)) {
      getDb().prepare('UPDATE conversations SET parent_id = ? WHERE id = ?').run(parentId, existing.id)
      return getConv(existing.id)!
    }
    return existing
  }

  const id = uuid()
  getDb()
    .prepare(
      // Explicit NULL model: the column default is a stale id, and NULL means
      // "the instance default" — what talking in it should use. The routine's
      // own model is passed per run.
      `INSERT INTO conversations (id, title, model, effort, last_read_at, notify, parent_id)
       VALUES (?, ?, NULL, 'default', unixepoch(), ?, ?)`,
    )
    .run(id, entry.name, notify, parentId)
  getDb().prepare(`UPDATE ${table} SET thread_id = ? WHERE id = ?`).run(id, entry.id)
  entry.thread_id = id
  return getConv(id)!
}

/** Re-point a routine's conversation at the chat it now hangs under. */
export function syncThreadParent(threadId: string | null, parentId: string | null): void {
  if (!threadId) return
  const conv = getConv(threadId)
  if (!conv || conv.parent_id === parentId || wouldCycle(threadId, parentId)) return
  getDb().prepare('UPDATE conversations SET parent_id = ? WHERE id = ?').run(parentId, threadId)
  emitGlobalEvent({ type: 'conversation_changed', conversation_id: threadId })
}

/**
 * The prompt block a routine's run starts with. A run is nobody's message, so
 * the model is told what it is and how to say "nothing to report" — the
 * `[quiet]` opener is what keeps a routine that fires hourly from raising a
 * badge every hour.
 */
export function routineRunPrompt(
  name: string,
  kind: 'cron' | 'webhook',
  parent?: { id: string; title: string } | null,
): string {
  // The run's own session starts empty: without this it could not know which
  // chat it works for, let alone read what was said there.
  const attached = parent
    ? [
        `It runs in a thread under the chat "${parent.title}" (conversation ${parent.id}). You do not remember that chat; when the task depends on what was said there, read it:`,
        `curl -s -H "X-Internal-Secret: $INTERNAL_SECRET" "$BACKEND_URL/internal/conversations/${parent.id}/messages?limit=20"`,
      ]
    : []
  return [
    '<article data-jarvis="routine-run">',
    `This is a run of the routine "${name}" (${kind === 'cron' ? 'on a schedule' : 'triggered by a webhook'}), not a message typed by the user.`,
    ...attached,
    'The user only hears about it when it matters. If there is nothing worth their attention — nothing new, nothing to do, every check fine —',
    'begin your final answer with the marker [quiet] followed by a one-line summary. Otherwise answer normally and lead with what matters:',
    'it shows as unread, without a phone notification. When it is worth interrupting them for — time-sensitive, or something they must act on —',
    'begin your final answer with [push: <one-line summary>] instead; that line becomes the notification.',
    'When your work already shows somewhere else (an app you updated, a file) and needs no message, yet the user should still be told,',
    'begin with both: [quiet] [push: <one-line summary>] — no unread, just the notification.',
    'Errors and questions always reach the user; do not mark those [quiet].',
    '</article>',
  ].join('\n')
}

const plain = (text: string) =>
  text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*>]\s+/gm, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 200)

/**
 * A routine's run closed: tell the person, if it is worth it.
 *
 * `worthy` decides whether it is news at all — an error, a run cut short, or a
 * done with something to say. News moves the conversation up and counts as
 * unread; a quiet run does neither. Stopped runs are the person's own doing
 * and say nothing. `push` is the run asking for a notification (its [push]
 * marker); the conversation's notify mode says whether it gets one: Always
 * pushes whatever was news, No push never does, and Auto pushes what the run
 * asked for — and failures, which the person has to know about.
 */
export function reportRun(run: RunRow, quiet: boolean, push: { summary: string | null } | null = null): void {
  const conv = getConv(run.conversation_id)
  if (!conv || run.status === 'stopped') return
  const failed = run.status === 'error' || run.status === 'interrupted'
  const worthy = failed || (run.status === 'done' && !quiet)
  const text = failed ? run.error || 'The run failed.' : (run.result ?? '').trim() || 'Done.'
  if (worthy) {
    getDb().prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(conv.id)
    emitGlobalEvent({ type: 'new_message', conversation_id: conv.id })
  }
  // A [push] rings even on a quiet run: the run asked, and only No push
  // overrules it. Always adds whatever was news.
  const asked = failed || !!push
  const pushes = conv.notify === 'subscribe' ? worthy || asked : conv.notify === 'auto' && asked
  if (!pushes) return
  pushForConversation(conv.id, conv.title, push?.summary || plain(text)).catch((err) =>
    console.error('[push] run push failed:', err),
  )
}

// ── A chat and its threads ─────────────────────────────────────────────
//
// A thread runs on its own session — forked from its chat when it was opened
// on a passage, fresh for a routine — and neither sees the other. Work done in
// one went unnoticed in the other: the same document drafted twice, a decision
// taken in a thread re-asked in the chat. Each now hears, on its next turn,
// what the other said meanwhile.

/** Absolute paths an answer mentions — what a thread made is usually linked in it. */
function pathsIn(text: string): string[] {
  return [...new Set(text.match(/\/jarvis\/[^\s)"'`\]>]+/g) ?? [])].slice(0, 10)
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** Before the person's turn in a chat: what its threads did since they last wrote here. */
export function threadActivityPrompt(conversationId: string): string | null {
  const db = getDb()
  const since = (db.prepare(
    `SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'`,
  ).get(conversationId) as { t: number | null }).t ?? 0
  const threads = db.prepare(
    `SELECT id, title FROM conversations WHERE parent_id = ?`,
  ).all(conversationId) as { id: string; title: string }[]
  const blocks: string[] = []
  for (const t of threads) {
    // A private thread's work never reaches another chat's prompt (private.ts).
    if (isPrivateConversation(t.id)) continue
    const answers = db.prepare(
      `SELECT result, created_at FROM messages
        WHERE conversation_id = ? AND role = 'assistant' AND type IS NULL AND result IS NOT NULL AND created_at > ?
          AND COALESCE(metadata, '') NOT LIKE '%"quiet":true%'
        ORDER BY created_at ASC, rowid ASC`,
    ).all(t.id, since) as { result: string; created_at: number }[]
    if (!answers.length) continue
    const last = answers[answers.length - 1]
    const asked = db.prepare(
      `SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(t.id) as { content: string } | undefined
    const files = pathsIn(answers.map((a) => a.result).join('\n'))
    blocks.push([
      `### Thread "${t.title}" (conversation ${t.id}) — ${answers.length} answer${answers.length > 1 ? 's' : ''}, last at ${new Date(last.created_at * 1000).toISOString()}`,
      ...(asked ? [`Last asked there: ${clip(asked.content.trim(), 300)}`] : []),
      `Last answer: ${clip(last.result.trim(), 1500)}`,
      ...(files.length ? [`Files it mentions: ${files.join(', ')}`] : []),
    ].join('\n'))
  }
  if (!blocks.length) return null
  return [
    '<article data-jarvis="thread-activity">',
    "Threads of this chat (side chats, and routines running under it) moved on since the user last wrote here. They ran in their own sessions: you have not seen this work. Build on it — don't redo a document or a decision a thread already made; read a thread in full with GET /internal/conversations/<id>/messages.",
    '',
    clip(blocks.join('\n\n'), 8000),
    '</article>',
  ].join('\n')
}

/** Before the person's turn in a thread: what was said in its chat since the thread last spoke. */
export function parentActivityPrompt(conv: ConvRow): string | null {
  if (!conv.parent_id) return null
  const db = getDb()
  const parent = getConv(conv.parent_id)
  // Nor does a private chat's reach its threads' (they are made private with
  // it, but one opened before the chat went private is not).
  if (!parent || isPrivateConversation(parent.id)) return null
  // The fork carried the chat up to the thread's opening; after that, the
  // thread knows the chat as of its own last turn.
  const since = Math.max(
    conv.created_at,
    (db.prepare(`SELECT MAX(created_at) AS t FROM messages WHERE conversation_id = ? AND role = 'user'`).get(conv.id) as { t: number | null }).t ?? 0,
  )
  // The latest of it: a thread quiet for months must not be handed its
  // chat's whole history, oldest first, cut off before the part that matters.
  const rows = (db.prepare(
    `SELECT role, content, result FROM messages
      WHERE conversation_id = ? AND type IS NULL AND created_at > ?
        AND (role = 'user' OR result IS NOT NULL)
        AND COALESCE(metadata, '') NOT LIKE '%"quiet":true%'
      ORDER BY created_at DESC, rowid DESC LIMIT 20`,
  ).all(parent.id, since) as { role: string; content: string; result: string | null }[]).reverse()
  if (!rows.length) return null
  const lines = rows.map((r) => `**${r.role === 'user' ? 'User' : 'Jarvis'}:** ${clip(((r.role === 'user' ? r.content : r.result) ?? '').trim(), 1200)}`)
  const files = pathsIn(rows.map((r) => r.result ?? '').join('\n'))
  return [
    '<article data-jarvis="parent-chat-activity">',
    `This thread hangs under the chat "${parent.title}" (conversation ${parent.id}). Since this thread last spoke, the chat went on without it — here is what was said there. Build on it rather than redoing it.`,
    '',
    clip(lines.join('\n\n'), 8000),
    ...(files.length ? ['', `Files mentioned there: ${files.join(', ')}`] : []),
    '</article>',
  ].join('\n')
}

const NOTIFY_MODES: ConvRow['notify'][] = ['subscribe', 'unsubscribe', 'auto']

export function validNotify(v: unknown): ConvRow['notify'] {
  return NOTIFY_MODES.includes(v as ConvRow['notify']) ? (v as ConvRow['notify']) : 'auto'
}

/** A webhook's legacy notify word, as the thread's mode. */
export function threadNotifyOf(v: unknown): ConvRow['notify'] {
  return v === 'never' ? 'unsubscribe' : v === 'always' ? 'subscribe' : 'auto'
}

/** Set the notify mode of a routine's conversation. */
export function setThreadNotify(threadId: string | null, notify: ConvRow['notify']): void {
  if (!threadId) return
  getDb()
    .prepare(`UPDATE conversations SET notify = ? WHERE id = ?`)
    .run(notify, threadId)
}

/**
 * Boot: every routine has its thread, so its settings (the thread's notify
 * mode) and its page have somewhere to live before its first run.
 */
export function ensureRoutineThreads(): void {
  for (const table of ['crons', 'webhooks'] as const) {
    const rows = getDb()
      .prepare(
        `SELECT * FROM ${table} r
          WHERE r.thread_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = r.thread_id)`,
      )
      .all() as (RoutineRef & { notify?: string })[]
    for (const row of rows) {
      ensureThread(table, row, table === 'webhooks' ? threadNotifyOf(row.notify) : 'auto')
    }
    if (rows.length) console.log(`[threads] opened ${rows.length} thread(s) for ${table}`)
  }
}

/** A routine renamed: its conversation follows, unless someone renamed it by hand. */
export function renameThread(threadId: string | null, from: string, to: string): void {
  if (!threadId || from === to) return
  // Untitled (a chat made a routine before it said anything): the routine names it.
  const r = getDb()
    .prepare(`UPDATE conversations SET title = ? WHERE id = ? AND title IN (?, ?)`)
    .run(to, threadId, from, UNTITLED)
  if (r.changes) emitConversationEvent(threadId, { type: 'conversation', id: threadId, title: to })
}

/** The routine a thread belongs to, if any. */
export function routineOfThread(threadId: string):
  | { table: RoutineTable; row: Record<string, unknown> & { id: string; name: string } }
  | null {
  for (const table of ['crons', 'webhooks'] as const) {
    const row = getDb().prepare(`SELECT * FROM ${table} WHERE thread_id = ?`).get(threadId) as
      | (Record<string, unknown> & { id: string; name: string })
      | undefined
    if (row) return { table, row }
  }
  return null
}

/**
 * What a person's turn in a routine's conversation is told about it. Talking
 * there is how a routine is changed: the model gets the routine as it stands
 * and the skill that edits it. Small,
 * and sent every turn — the routine can change between two messages, from the
 * Routines page or another chat.
 */
export function threadContextPrompt(conv: ConvRow): string | null {
  const found = routineOfThread(conv.id)
  if (!found) return null
  const parent = getConv(conv.parent_id)
  const where = parent
    ? `It hangs under the chat "${parent.title}" (conversation ${parent.id}).`
    : 'It hangs under no chat.'
  const { table, row } = found
  const settings: Record<string, unknown> = {
    kind: table === 'crons' ? 'cron' : 'webhook',
    id: row.id,
    name: row.name,
    ...(table === 'crons' ? { schedule: row.schedule, once: !!row.once } : {}),
    enabled: !!row.enabled,
    prompt: row.prompt,
    model: row.model ?? 'instance default',
    attached_to: parent ? { conversation_id: parent.id, title: parent.title } : null,
    notify: conv.notify,
  }
  return [
    '<article data-jarvis="routine-thread">',
    `This conversation is the routine "${row.name}": every run of it happens here. ${where}`,
    'Its current settings:',
    JSON.stringify(settings, null, 2),
    'If the user asks to change, pause, re-target or delete it, use the `routine-setup` skill. Otherwise this is an ordinary conversation about its runs.',
    '</article>',
  ].join('\n')
}

/** Why a routine write points somewhere it can't, or null. */
export function checkRoutineRefs(body: { conversation_id?: string | null; thread_id?: string; notify?: string }): string | null {
  if (body.conversation_id && !getConv(body.conversation_id)) {
    return 'conversation_id must be an existing conversation'
  }
  if (body.thread_id && !getConv(body.thread_id)) {
    return 'thread_id must be an existing conversation'
  }
  if (body.conversation_id && body.thread_id && wouldCycle(body.thread_id, body.conversation_id)) {
    return 'conversation_id cannot be the routine\'s own conversation or one under it'
  }
  if (body.notify !== undefined && !NOTIFY_MODES.includes(body.notify as ConvRow['notify'])) {
    return 'notify must be subscribe, unsubscribe or auto'
  }
  return null
}

/**
 * After a routine was created or changed through the agent's API: give it its
 * thread (the one it was set up in, or a new one), keep the thread's name,
 * parent and notify mode in step, and tell open screens.
 */
export function afterRoutineWrite(
  table: RoutineTable,
  id: string,
  previousName: string | null,
  body: { thread_id?: string; notify?: string },
): Record<string, unknown> & RoutineRef {
  const db = getDb()
  if (body.thread_id) db.prepare(`UPDATE ${table} SET thread_id = ? WHERE id = ?`).run(body.thread_id, id)
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> & RoutineRef
  const notify = body.notify !== undefined ? validNotify(body.notify) : undefined
  const thread = ensureThread(table, row, notify ?? (table === 'webhooks' ? threadNotifyOf(row.notify) : 'auto'))
  if (notify) setThreadNotify(thread.id, notify)
  renameThread(thread.id, previousName ?? 'New routine', row.name)
  emitGlobalEvent({ type: 'routine_changed', thread_id: thread.id })
  emitGlobalEvent({ type: 'conversation_changed', conversation_id: thread.id })
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> & RoutineRef
}
