import type { FastifyInstance } from 'fastify'
import cron from 'node-cron'
import { getDb, uuid } from '../db.js'
import { schedule, rescheduleAll, fireCron } from '../crons.js'
import type { CronRow } from '../types.js'

export async function cronRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  app.get('/', auth, async () => {
    return getDb().prepare('SELECT * FROM crons ORDER BY created_at ASC').all()
  })

  app.post('/', auth, async (req, reply) => {
    const body = req.body as {
      name: string
      schedule: string
      prompt: string
      enabled?: boolean
      once?: boolean
      model?: string
      thinking?: boolean
    }

    if (!body.name || !body.schedule || !body.prompt) {
      return reply.code(400).send({ error: 'name, schedule, and prompt are required' })
    }
    if (!cron.validate(body.schedule)) {
      return reply.code(400).send({ error: 'Invalid cron schedule expression' })
    }

    const id = uuid()
    const enabled = body.enabled !== false ? 1 : 0
    const once = body.once ? 1 : 0
    const model = body.model ?? 'claude-opus-4-8'
    const thinking = body.thinking ? 1 : 0

    getDb()
      .prepare('INSERT INTO crons (id, name, schedule, prompt, enabled, once, model, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, body.schedule, body.prompt, enabled, once, model, thinking)

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
      thinking: boolean
    }>

    if (body.schedule && !cron.validate(body.schedule)) {
      return reply.code(400).send({ error: 'Invalid cron schedule expression' })
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
      model: body.model ?? existing.model ?? 'claude-opus-4-8',
      thinking: body.thinking !== undefined ? (body.thinking ? 1 : 0) : existing.thinking,
    }

    getDb()
      .prepare('UPDATE crons SET name=?, schedule=?, prompt=?, enabled=?, once=?, model=?, thinking=? WHERE id=?')
      .run(updated.name, updated.schedule, updated.prompt, updated.enabled, updated.once, updated.model, updated.thinking, req.params.id)

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
