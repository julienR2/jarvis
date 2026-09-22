import type { FastifyInstance } from 'fastify'
import cron from 'node-cron'
import { getDb, uuid, normalizeEffort } from '../db.js'
import { schedule, rescheduleAll, fireCron, nextRun } from '../crons.js'
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
      inherit_context?: boolean
      /** Only fire when no run is active anywhere. */
      solo?: boolean
      /** Where the runs post. Omitted: a chat is opened on the first fire. */
      conversation_id?: string | null
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
    // Off by default: a scheduled prompt is normally self-contained, and
    // inheriting the conversation means re-reading (and paying for) its whole
    // history on every fire.
    const inheritContext = body.inherit_context ? 1 : 0
    const solo = body.solo ? 1 : 0

    getDb()
      .prepare('INSERT INTO crons (id, name, schedule, prompt, enabled, once, model, effort, inherit_context, solo, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, body.schedule, body.prompt, enabled, once, model, effort, inheritContext, solo, body.conversation_id || null)

    const row = getDb().prepare('SELECT * FROM crons WHERE id = ?').get(id) as CronRow
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
      inherit_context: boolean
      solo: boolean
      conversation_id: string | null
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
      inherit_context:
        body.inherit_context !== undefined
          ? (body.inherit_context ? 1 : 0)
          : existing.inherit_context,
      solo: body.solo !== undefined ? (body.solo ? 1 : 0) : existing.solo,
      // null unlinks it: the next fire opens a fresh chat.
      conversation_id: 'conversation_id' in body ? (body.conversation_id || null) : existing.conversation_id,
    }

    getDb()
      .prepare('UPDATE crons SET name=?, schedule=?, prompt=?, enabled=?, once=?, model=?, effort=?, inherit_context=?, solo=?, conversation_id=? WHERE id=?')
      .run(updated.name, updated.schedule, updated.prompt, updated.enabled, updated.once, updated.model, updated.effort, updated.inherit_context, updated.solo, updated.conversation_id, req.params.id)

    const row = getDb().prepare('SELECT * FROM crons WHERE id = ?').get(req.params.id) as CronRow
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
