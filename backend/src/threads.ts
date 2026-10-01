// Threads — where a routine runs.
//
// A routine (cron or webhook) owns one thread: a conversation of kind 'thread'
// that the sidebar keeps out of the chat groups. Every fire is a run in it, so
// the whole history of what the routine did reads in one place, and the person
// can open it and talk to it like any chat.
//
// A thread may be attached to a chat (`parent_id`). It then never notifies on
// its own: each finished run leaves a report in the parent — the answer when
// there was something to say, a silent line when there was not — and the
// parent's notify mode decides about the push. A thread attached to nothing
// shows up in the sidebar's Threads group when a run had something worth
// seeing, and stays there until it is dismissed.

import { getDb, uuid } from './db.js'
import { emitConversationEvent, emitGlobalEvent } from './sse.js'
import { pushForConversation } from './push.js'
import type { ConvRow, MessageRow, RunRow, RunStatus } from './types.js'

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

/**
 * The routine's thread, opened on first use — or again after its thread was
 * deleted or moved into the chats. The parent is re-read from the routine on
 * every fire, so re-attaching a routine takes effect on its next run.
 */
export function ensureThread(
  table: RoutineTable,
  entry: RoutineRef,
  notify: ConvRow['notify'] = 'auto',
): ConvRow {
  const parentId = getConv(entry.conversation_id)?.id ?? null
  const existing = getConv(entry.thread_id)
  if (existing && existing.kind === 'thread') {
    if (existing.parent_id !== parentId) {
      getDb().prepare('UPDATE conversations SET parent_id = ? WHERE id = ?').run(parentId, existing.id)
      existing.parent_id = parentId
    }
    return existing
  }

  const id = uuid()
  getDb()
    .prepare(
      // Explicit NULL model: the column default is a stale id, and NULL means
      // "the instance default" — what talking in the thread should use. The
      // routine's own model is passed per run.
      `INSERT INTO conversations (id, title, model, effort, last_read_at, notify, kind, parent_id)
       VALUES (?, ?, NULL, 'default', unixepoch(), ?, 'thread', ?)`,
    )
    .run(id, entry.name, notify, parentId)
  getDb().prepare(`UPDATE ${table} SET thread_id = ? WHERE id = ?`).run(id, entry.id)
  entry.thread_id = id
  return getConv(id)!
}

/** Re-point a routine's thread at the chat it now reports into. */
export function syncThreadParent(threadId: string | null, parentId: string | null): void {
  if (!threadId) return
  getDb()
    .prepare(`UPDATE conversations SET parent_id = ? WHERE id = ? AND kind = 'thread'`)
    .run(parentId, threadId)
}

/**
 * The prompt block a routine's run starts with. A run is nobody's message, so
 * the model is told what it is and how to say "nothing to report" — the
 * `[quiet]` opener is what keeps a routine that fires hourly from raising a
 * badge every hour.
 */
export function routineRunPrompt(name: string, kind: 'cron' | 'webhook'): string {
  return [
    '<article data-jarvis="routine-run">',
    `This is a run of the routine "${name}" (${kind === 'cron' ? 'on a schedule' : 'triggered by a webhook'}), not a message typed by the user.`,
    'The user only hears about it when it matters. If there is nothing worth their attention — nothing new, nothing to do, every check fine —',
    'begin your final answer with the marker [quiet] followed by a one-line summary. Otherwise answer normally and lead with what matters.',
    'Errors and questions always reach the user; do not mark those [quiet].',
    '</article>',
  ].join('\n')
}

/** The report a finished run leaves in the chat its thread is attached to. */
export interface RunReport {
  run_id: string
  thread_id: string
  source_name: string
  kind: 'cron' | 'webhook'
  status: RunStatus
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
 * A run in a thread closed: tell whoever should hear about it.
 *
 * `worthy` is the whole decision — an error, a run cut short, or a done with
 * something to say. Stopped runs are the person's own doing and say nothing.
 */
export function reportRun(run: RunRow, quiet: boolean): void {
  const thread = getConv(run.conversation_id)
  if (!thread || thread.kind !== 'thread') return
  const failed = run.status === 'error' || run.status === 'interrupted'
  if (run.status === 'stopped') return
  const worthy = failed || (run.status === 'done' && !quiet)
  const text = failed
    ? run.error || 'The run failed.'
    : (run.result ?? '').trim() || 'Done.'

  const parent = getConv(thread.parent_id)
  if (parent) {
    const report: RunReport = {
      run_id: run.id,
      thread_id: thread.id,
      source_name: run.source_name,
      kind: run.kind,
      status: run.status,
    }
    const meta: Record<string, unknown> = { report }
    if (!worthy) meta.quiet = true
    const id = uuid()
    getDb()
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, result, metadata)
         VALUES (?, ?, 'assistant', '', ?, ?)`,
      )
      .run(id, parent.id, text, JSON.stringify(meta))
    const row = getDb()
      .prepare('SELECT *, rowid AS seq FROM messages WHERE id = ?')
      .get(id) as MessageRow
    emitConversationEvent(parent.id, { type: 'message', message: row })
    // A silent report is a line in the transcript, not activity: it does not
    // move the chat up the sidebar, count as unread, or ring anything.
    if (!worthy) return
    getDb().prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(parent.id)
    emitGlobalEvent({ type: 'new_message', conversation_id: parent.id })
    // Auto counts a routine's worthy report as worth a push: the routine was
    // already told to stay quiet when it had nothing.
    if (parent.notify !== 'unsubscribe') {
      pushForConversation(parent.id, `${parent.title} · ${run.source_name}`, plain(text)).catch((err) =>
        console.error('[push] report push failed:', err),
      )
    }
    return
  }

  if (!worthy || thread.notify === 'unsubscribe') return
  surfaceThread(thread.id)
  emitGlobalEvent({ type: 'new_message', conversation_id: thread.id })
  pushForConversation(thread.id, thread.title, plain(text)).catch((err) =>
    console.error('[push] thread push failed:', err),
  )
}

/** List a thread in the sidebar's Threads group (again). */
export function surfaceThread(id: string): void {
  const r = getDb()
    .prepare(`UPDATE conversations SET surfaced_at = unixepoch() WHERE id = ? AND kind = 'thread'`)
    .run(id)
  if (r.changes) emitGlobalEvent({ type: 'conversation_changed', conversation_id: id })
}

/**
 * Where a push about this conversation should go: a thread attached to a chat
 * speaks through it, with the chat's notify mode.
 */
export function notifyTarget(conv: ConvRow): ConvRow {
  if (conv.kind !== 'thread') return conv
  return getConv(conv.parent_id) ?? conv
}

/**
 * The run reports that landed in a chat since the person last wrote there,
 * as a prompt block. They were written by other sessions, so the chat's own
 * session has never seen them — and "ok, do it" under one is about it.
 */
export function unseenReportsPrompt(conversationId: string): string | null {
  const rows = getDb()
    .prepare(
      `SELECT result, metadata, created_at FROM messages
        WHERE conversation_id = ? AND metadata LIKE '%"report"%'
          AND COALESCE(metadata, '') NOT LIKE '%"quiet":true%'
          AND rowid > COALESCE((SELECT MAX(rowid) FROM messages WHERE conversation_id = ? AND role = 'user'), 0)
        ORDER BY rowid ASC`,
    )
    .all(conversationId, conversationId) as { result: string | null; metadata: string; created_at: number }[]
  const reports = rows.flatMap((r) => {
    try {
      const report = JSON.parse(r.metadata).report as RunReport | undefined
      if (!report) return []
      const at = new Date(r.created_at * 1000).toISOString()
      return [`### ${report.source_name} — ${report.status} at ${at}\n${(r.result ?? '').slice(0, 4000)}`]
    } catch {
      return []
    }
  })
  if (reports.length === 0) return null
  return [
    '<article data-jarvis="routine-reports">',
    'Routines attached to this chat posted these reports since the user last wrote here. They ran in their own threads, so you have not seen them; the user may be reacting to them.',
    '',
    reports.join('\n\n'),
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

export function setThreadNotify(threadId: string | null, notify: ConvRow['notify']): void {
  if (!threadId) return
  getDb().prepare(`UPDATE conversations SET notify = ? WHERE id = ? AND kind = 'thread'`).run(notify, threadId)
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
             OR NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = r.thread_id AND c.kind = 'thread')`,
      )
      .all() as (RoutineRef & { notify?: string })[]
    for (const row of rows) {
      ensureThread(table, row, table === 'webhooks' ? threadNotifyOf(row.notify) : 'auto')
    }
    if (rows.length) console.log(`[threads] opened ${rows.length} thread(s) for ${table}`)
  }
}

/** A routine renamed: its thread follows, unless someone renamed the thread by hand. */
export function renameThread(threadId: string | null, from: string, to: string): void {
  if (!threadId || from === to) return
  const r = getDb()
    .prepare(`UPDATE conversations SET title = ? WHERE id = ? AND kind = 'thread' AND title = ?`)
    .run(to, threadId, from)
  if (r.changes) emitConversationEvent(threadId, { type: 'conversation', id: threadId, title: to })
}
