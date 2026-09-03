import cron, { type ScheduledTask } from 'node-cron'
import { getDb, uuid } from './db.js'
import { config } from './config.js'
import { processMessage } from './routes/conversations.js'
import type { CronRow, ConvRow } from './types.js'

const tasks = new Map<string, ScheduledTask>()

function ensureConversation(entry: CronRow): { conversationId: string; conv: ConvRow } {
  if (entry.conversation_id) {
    const conv = getDb()
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(entry.conversation_id) as ConvRow | undefined
    if (conv) {
      return { conversationId: conv.id, conv }
    }
  }

  // Create a new conversation for this cron
  const convId = uuid()
  getDb()
    .prepare(
      `INSERT INTO conversations (id, title, last_read_at, notify)
       VALUES (?, ?, unixepoch(), 'auto')`,
    )
    .run(convId, `Cron: ${entry.name}`)

  // Link the cron to this conversation
  getDb()
    .prepare('UPDATE crons SET conversation_id = ? WHERE id = ?')
    .run(convId, entry.id)
  entry.conversation_id = convId

  const conv = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as ConvRow
  return { conversationId: convId, conv }
}

export function fireCron(entry: CronRow): void {
  console.log(`[cron] firing "${entry.name}"`)

  getDb()
    .prepare('UPDATE crons SET last_run = unixepoch() WHERE id = ?')
    .run(entry.id)

  if (entry.once) {
    getDb().prepare('DELETE FROM crons WHERE id = ?').run(entry.id)
    unschedule(entry.id)
  }

  const { conversationId, conv } = ensureConversation(entry)

  processMessage(conversationId, conv, entry.prompt, [], {
    skipUserMessage: true,
    model: entry.model ?? undefined,
    effort: entry.effort,
    onDone: (text) => {
      getDb()
        .prepare('UPDATE crons SET last_result = ? WHERE id = ?')
        .run(text, entry.id)
    },
  })
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
