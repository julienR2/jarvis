import cron, { type ScheduledTask } from 'node-cron'
import { getDb } from './db.js'
import { config } from './config.js'
import { processMessage } from './routes/conversations.js'
import { startRun } from './runs.js'
import { ensureThread } from './threads.js'
import type { CronRow } from './types.js'

const tasks = new Map<string, ScheduledTask>()

export function fireCron(entry: CronRow): void {
  console.log(`[cron] firing "${entry.name}"`)

  getDb()
    .prepare('UPDATE crons SET last_run = unixepoch() WHERE id = ?')
    .run(entry.id)

  if (entry.once) {
    getDb().prepare('DELETE FROM crons WHERE id = ?').run(entry.id)
    unschedule(entry.id)
  }

  const thread = ensureThread('crons', entry)

  // Every fire starts a fresh session in the routine's thread, under a key of
  // its own so two fires never share one. The thread then resumes the latest
  // run's session, so replying in it picks up where that run left off.
  const runKey = `cron-${entry.id}-${Date.now()}`

  // Recorded before the prompt is sent, so the run is stoppable from the very
  // first moment it exists rather than from whenever the engine answers.
  const run = startRun({
    kind: 'cron',
    sourceId: entry.id,
    sourceName: entry.name,
    conversationId: thread.id,
    runKey,
  })

  processMessage(thread.id, thread, entry.prompt, [], {
    skipUserMessage: true,
    model: entry.model ?? undefined,
    effort: entry.effort,
    runKey,
    runId: run.id,
    routine: { name: entry.name, kind: 'cron' },
    onDone: (text) => {
      getDb()
        .prepare('UPDATE crons SET last_result = ? WHERE id = ?')
        .run(text, entry.id)
    },
  })
}

/**
 * When a scheduled cron fires next, as a unix timestamp — from the live task,
 * which is the only thing that knows (node-cron computes it in the scheduler's
 * timezone; the client turns it local). Null for a cron that isn't scheduled.
 */
export function nextRun(id: string): number | null {
  const next = tasks.get(id)?.getNextRun()
  return next ? Math.floor(next.getTime() / 1000) : null
}

function unschedule(id: string): void {
  tasks.get(id)?.stop()
  tasks.delete(id)
}

export function schedule(entry: CronRow): void {
  unschedule(entry.id)
  if (!entry.enabled) return
  if (!cron.validate(entry.schedule)) {
    console.warn(`[cron] invalid schedule for "${entry.name}": ${entry.schedule}`)
    return
  }
  const task = cron.schedule(entry.schedule, () => {
    const fresh = getDb().prepare('SELECT * FROM crons WHERE id = ?').get(entry.id) as CronRow | undefined
    if (fresh) fireCron(fresh)
    else unschedule(entry.id)
  }, {
    timezone: config.tz,
  })
  tasks.set(entry.id, task)
}

export function startCronScheduler(): void {
  const rows = getDb().prepare('SELECT * FROM crons WHERE enabled = 1').all() as CronRow[]
  for (const row of rows) schedule(row)
  console.log(`[cron] loaded ${rows.length} cron(s)`)
}

export function rescheduleAll(): void {
  for (const [id] of tasks) unschedule(id)
  startCronScheduler()
}
