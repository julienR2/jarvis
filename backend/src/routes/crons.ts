import type { FastifyInstance } from 'fastify'
import cron from 'node-cron'
import { getDb, uuid, normalizeEffort } from '../db.js'
import { schedule, rescheduleAll, fireCron, nextRun } from '../crons.js'
import { ensureThread, setThreadNotify, syncThreadParent, renameThread, validNotify } from '../threads.js'
import type { CronRow } from '../types.js'

function conversationExists(id: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)
}

export async function cronRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  app.get('/', auth, async () => {
    return getDb().prepare('SELECT * FROM crons ORDER BY created_at ASC').all()
  })

  /**
   * The enabled crons with their next fire time, soonest first — what Today's
   * "Coming up" lists. A cron whose task isn't live (invalid expression) has
   * no next run and sorts last.
   */
  app.get('/upcoming', auth, async () => {
    const rows = getDb()
      .prepare('SELECT id, name, schedule, conversation_id FROM crons WHERE enabled = 1')
      .all() as Pick<CronRow, 'id' | 'name' | 'schedule' | 'conversation_id'>[]
    return rows
      .map((row) => ({ ...row, next_run: nextRun(row.id) }))
      .sort((a, b) => (a.next_run ?? Infinity) - (b.next_run ?? Infinity))
  })

  app.post('/', auth, async (req, reply) => {
    const body = req.body as {
      name: string
      schedule: string
      prompt: string
      enabled?: boolean
      once?: boolean
      model?: string
      effort?: string
      /** The chat the runs report into. Omitted: the thread stands alone. */
      conversation_id?: string | null
      /** The thread's notify mode — only matters while it stands alone. */
      notify?: 'subscribe' | 'unsubscribe' | 'auto'
    }

    if (!body.name || !body.schedule || !body.prompt) {
      return reply.code(400).send({ error: 'name, schedule, and prompt are required' })
    }
    if (!cron.validate(body.schedule)) {
      return reply.code(400).send({ error: 'Invalid cron schedule expression' })
    }
    if (body.conversation_id && !conversationExists(body.conversation_id)) {
      return reply.code(400).send({ error: 'Unknown conversation' })
    }

    const id = uuid()
    const enabled = body.enabled !== false ? 1 : 0
    const once = body.once ? 1 : 0
    const model = body.model ?? null // null → global default (resolved at fire time)
    const effort = normalizeEffort(body.effort)

    getDb()
      .prepare('INSERT INTO crons (id, name, schedule, prompt, enabled, once, model, effort, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, body.schedule, body.prompt, enabled, once, model, effort, body.conversation_id || null)

    const row = getDb().prepare('SELECT * FROM crons WHERE id = ?').get(id) as CronRow
    // The thread is opened now rather than on the first fire, so the routine
    // has somewhere to be looked at — and its notify mode somewhere to live.
    ensureThread('crons', row, validNotify(body.notify))
    schedule(row)
    return row
  })

  app.patch<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const body = req.body as Partial<{
      name: string
      schedule: string
      prompt: string
      enabled: boolean
      once: boolean
      model: string
      effort: string
      conversation_id: string | null
      notify: 'subscribe' | 'unsubscribe' | 'auto'
    }>

    if (body.schedule && !cron.validate(body.schedule)) {
      return reply.code(400).send({ error: 'Invalid cron schedule expression' })
    }
    if (body.conversation_id && !conversationExists(body.conversation_id)) {
      return reply.code(400).send({ error: 'Unknown conversation' })
    }

    const existing = getDb()
      .prepare('SELECT * FROM crons WHERE id = ?')
      .get(req.params.id) as CronRow | undefined

    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const updated = {
      name: body.name ?? existing.name,
      schedule: body.schedule ?? existing.schedule,
      prompt: body.prompt ?? existing.prompt,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      once: body.once !== undefined ? (body.once ? 1 : 0) : existing.once,
      model: body.model ?? existing.model ?? null,
      effort: body.effort !== undefined ? normalizeEffort(body.effort) : existing.effort,
      // null detaches it: the thread stands alone from the next run on.
      conversation_id: 'conversation_id' in body ? (body.conversation_id || null) : existing.conversation_id,
    }

    getDb()
      .prepare('UPDATE crons SET name=?, schedule=?, prompt=?, enabled=?, once=?, model=?, effort=?, conversation_id=? WHERE id=?')
      .run(updated.name, updated.schedule, updated.prompt, updated.enabled, updated.once, updated.model, updated.effort, updated.conversation_id, req.params.id)

    const row = getDb().prepare('SELECT * FROM crons WHERE id = ?').get(req.params.id) as CronRow
    syncThreadParent(row.thread_id, row.conversation_id)
    renameThread(row.thread_id, existing.name, row.name)
    if (body.notify) setThreadNotify(row.thread_id, validNotify(body.notify))
    schedule(row)
    return row
  })

  app.post<{ Params: { id: string } }>('/:id/trigger', auth, async (req, reply) => {
    const row = getDb()
      .prepare('SELECT * FROM crons WHERE id = ?')
      .get(req.params.id) as CronRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    fireCron(row)
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const result = getDb().prepare('DELETE FROM crons WHERE id = ?').run(req.params.id)
    if (result.changes === 0) return reply.code(404).send({ error: 'Not found' })
    rescheduleAll()
    return { ok: true }
  })
}
