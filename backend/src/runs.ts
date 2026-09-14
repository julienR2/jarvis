// Runs — the lifecycle of one cron/webhook fire, persisted.
//
// A run is the missing noun that made background work unmanageable. It ties
// three things together that used to live in three different places (or
// nowhere at all):
//
//   run_key         → which engine session to interrupt, so Stop works
//   conversation_id → where the output lands, so the UI can show it in context
//   status          → whether it is still going, so a refresh doesn't lie
//
// Everything here is deliberately synchronous and small: the run row is written
// on the same tick as the fire, so a crash between "fired" and "recorded" is
// not a state the rest of the code has to reason about.

import { getDb, uuid } from './db.js'
import { emitConversationEvent , emitGlobalEvent } from './sse.js'
import { interruptConversation } from './engine.js'
import type { RunRow, RunKind, RunStatus } from './types.js'

const RUNS_PAGE_SIZE = 50

/** The engine key a run answers to: its own, or the conversation's. */
export function runSessionKey(run: RunRow): string {
  return run.run_key ?? run.conversation_id
}

function getRun(id: string): RunRow | undefined {
  return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined
}

/**
 * Push the conversation's current run list to its SSE clients.
 *
 * Sent as the whole list rather than a delta: it is a handful of rows, the
 * client wants exactly this shape to render, and a dropped delta would leave a
 * stale Stop button pointing at a run that already finished.
 */
function emitRuns(conversationId: string): void {
  emitConversationEvent(conversationId, {
    type: 'runs',
    runs: activeRuns(conversationId),
  })
  // Also app-wide, as a nudge rather than a payload: the Activity page and the
  // sidebar dot are not inside any conversation, and they know how to refetch
  // the shape they need.
  emitGlobalEvent({ type: 'runs', conversation_id: conversationId })
}

export function startRun(opts: {
  kind: RunKind
  sourceId: string | null
  sourceName: string
  conversationId: string
  /** Throwaway engine key for an isolated run; omit when inheriting. */
  runKey?: string
}): RunRow {
  const id = uuid()
  getDb()
    .prepare(
      `INSERT INTO runs (id, kind, source_id, source_name, conversation_id, run_key, inherit_context, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
    )
    .run(
      id,
      opts.kind,
      opts.sourceId,
      opts.sourceName,
      opts.conversationId,
      opts.runKey ?? null,
      opts.runKey ? 0 : 1,
    )
  const run = getRun(id)!
  emitRuns(opts.conversationId)
  return run
}

/**
 * Close a run out. Idempotent: the done and error paths can both fire for one
 * run (an error mid-turn followed by the session closing), and whichever lands
 * first wins — re-closing would overwrite a real error with a bland
 * `interrupted`.
 */
export function finishRun(
  id: string,
  status: Exclude<RunStatus, 'running'>,
  detail?: { result?: string; error?: string },
): void {
  const run = getRun(id)
  if (!run || run.status !== 'running') return
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, ended_at = unixepoch(), result = ?, error = ?
        WHERE id = ? AND status = 'running'`,
    )
    .run(status, detail?.result ?? null, detail?.error ?? null, id)
  emitRuns(run.conversation_id)
}

/** Runs still in flight for a conversation, oldest first. */
export function activeRuns(conversationId: string): RunRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM runs
        WHERE conversation_id = ? AND status = 'running'
        ORDER BY started_at ASC`,
    )
    .all(conversationId) as RunRow[]
}

/** A run as the Activity page lists it: with where it wrote, and a cursor. */
export interface RunListRow extends RunRow {
  /** Insertion order — the paging cursor. Runs are inserted when they start. */
  seq: number
  conversation_title: string | null
  section_id: string | null
}

export function listRuns(opts: {
  conversationId?: string
  /** One or several; omitted = all. */
  statuses?: RunStatus[]
  kind?: RunKind
  /** A section id, or 'none' for conversations outside any section. */
  sectionId?: string
  /** Only runs started at or after this unix time. */
  since?: number
  /** Only runs older (by insertion) than this `seq`. */
  before?: number
  limit?: number
}): RunListRow[] {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.conversationId) {
    where.push('r.conversation_id = ?')
    params.push(opts.conversationId)
  }
  if (opts.statuses?.length) {
    where.push(`r.status IN (${opts.statuses.map(() => '?').join(',')})`)
    params.push(...opts.statuses)
  }
  if (opts.kind) {
    where.push('r.kind = ?')
    params.push(opts.kind)
  }
  if (opts.sectionId === 'none') {
    where.push('c.section_id IS NULL')
  } else if (opts.sectionId) {
    where.push('c.section_id = ?')
    params.push(opts.sectionId)
  }
  if (opts.since) {
    where.push('r.started_at >= ?')
    params.push(opts.since)
  }
  if (opts.before) {
    where.push('r.rowid < ?')
    params.push(opts.before)
  }
  const limit = Math.min(Math.max(opts.limit ?? RUNS_PAGE_SIZE, 1), 200)
  params.push(limit)
  return getDb()
    .prepare(
      `SELECT r.*, r.rowid AS seq, c.title AS conversation_title, c.section_id AS section_id
         FROM runs r
         LEFT JOIN conversations c ON c.id = r.conversation_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.rowid DESC
        LIMIT ?`,
    )
    .all(...params) as RunListRow[]
}

/**
 * Interrupt a run's engine session and mark it stopped.
 *
 * The row is marked before the interrupt resolves: the engine's soft cancel
 * surfaces as an ordinary `done`, so waiting for it would let the done handler
 * record the run as a normal success.
 */
export async function stopRun(id: string): Promise<boolean> {
  const run = getRun(id)
  if (!run || run.status !== 'running') return false
  finishRun(id, 'stopped')
  await interruptConversation(runSessionKey(run))
  return true
}

/** Stop every run in flight for a conversation. Used by the chat Stop button. */
export async function stopRunsFor(conversationId: string): Promise<number> {
  const runs = activeRuns(conversationId)
  for (const run of runs) await stopRun(run.id)
  return runs.length
}

/**
 * Boot reconciliation: close out runs the previous process left `running`.
 *
 * Called AFTER the reconnect pass, which re-attaches to whatever the engine
 * still has alive — anything still marked running at that point has no stream
 * behind it and would otherwise show a Stop button forever.
 */
export function reconcileStaleRuns(): void {
  const stale = getDb()
    .prepare(`SELECT * FROM runs WHERE status = 'running'`)
    .all() as RunRow[]
  if (stale.length === 0) return
  getDb()
    .prepare(
      `UPDATE runs SET status = 'interrupted', ended_at = unixepoch(),
              error = 'Backend restarted while this run was in flight'
        WHERE status = 'running'`,
    )
    .run()
  console.log(`[runs] marked ${stale.length} stale run(s) as interrupted`)
  for (const conversationId of new Set(stale.map((r) => r.conversation_id))) {
    emitRuns(conversationId)
  }
}

/** Current status of a run, or undefined when the row is gone. */
export function runStatus(id: string): RunStatus | undefined {
  const row = getDb().prepare('SELECT status FROM runs WHERE id = ?').get(id) as
    | { status: RunStatus }
    | undefined
  return row?.status
}

/** The run behind an engine session key, for the restart-reconnect path. */
export function runByKey(runKey: string): RunRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM runs WHERE run_key = ? AND status = 'running'`)
    .get(runKey) as RunRow | undefined
}
