import type { FastifyInstance } from 'fastify'
import { getDb, uuid } from '../db.js'
import { fireWebhook } from '../webhooks.js'
import type { WebhookRow } from '../types.js'

export async function webhookRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  app.get('/', auth, async () => {
    return getDb().prepare('SELECT * FROM webhooks ORDER BY created_at ASC').all()
  })

  app.post('/', auth, async (req, reply) => {
    const body = req.body as {
      name: string
      prompt: string
      enabled?: boolean
    }

    if (!body.name || !body.prompt) {
      return reply.code(400).send({ error: 'name and prompt are required' })
    }

    const id = uuid()
    const token = uuid()
    const enabled = body.enabled !== false ? 1 : 0

    getDb()
      .prepare('INSERT INTO webhooks (id, name, token, prompt, enabled) VALUES (?, ?, ?, ?, ?)')
      .run(id, body.name, token, body.prompt, enabled)

    return getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
  })

  app.patch<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const body = req.body as Partial<{
      name: string
      prompt: string
      enabled: boolean
    }>

    const existing = getDb()
      .prepare('SELECT * FROM webhooks WHERE id = ?')
      .get(req.params.id) as WebhookRow | undefined

    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const updated = {
      name: body.name ?? existing.name,
      prompt: body.prompt ?? existing.prompt,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
    }

    getDb()
      .prepare('UPDATE webhooks SET name=?, prompt=?, enabled=? WHERE id=?')
      .run(updated.name, updated.prompt, updated.enabled, req.params.id)

    return getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id)
  })

  app.post<{ Params: { id: string } }>('/:id/trigger', auth, async (req, reply) => {
    const row = getDb()
      .prepare('SELECT * FROM webhooks WHERE id = ?')
      .get(req.params.id) as WebhookRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    fireWebhook(row)
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const result = getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.id)
    if (result.changes === 0) return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })
}

/** Public trigger route — no JWT, token in URL is the auth */
export async function webhookTriggerRoute(app: FastifyInstance) {
  app.post<{ Params: { token: string } }>('/:token/trigger', async (req, reply) => {
    const row = getDb()
      .prepare('SELECT * FROM webhooks WHERE token = ? AND enabled = 1')
      .get(req.params.token) as WebhookRow | undefined

    if (!row) return reply.code(404).send({ error: 'Not found' })

    const payload = (req.body && typeof req.body === 'object' && Object.keys(req.body as object).length > 0)
      ? req.body
      : undefined

    fireWebhook(row, payload)
    return { ok: true, webhook: row.name }
  })
}
