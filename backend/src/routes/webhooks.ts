import type { FastifyInstance } from 'fastify'
import { getDb, uuid, normalizeEffort } from '../db.js'
import { fireWebhook, fireWebhookSync } from '../webhooks.js'
import { cancelConversation } from './conversations.js'
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
      model?: string
      effort?: string
      notify?: 'auto' | 'never' | 'always'
      user_message_key?: string
    }

    if (!body.name || !body.prompt) {
      return reply.code(400).send({ error: 'name and prompt are required' })
    }

    const id = uuid()
    const token = uuid()
    const enabled = body.enabled !== false ? 1 : 0
    const model = body.model ?? 'claude-opus-4-8'
    const effort = normalizeEffort(body.effort)
    const notify = body.notify ?? 'auto'
    const user_message_key = body.user_message_key ?? null

    getDb()
      .prepare('INSERT INTO webhooks (id, name, token, prompt, enabled, model, effort, notify, user_message_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, token, body.prompt, enabled, model, effort, notify, user_message_key)

    return getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
  })

  app.patch<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const body = req.body as Partial<{
      name: string
      prompt: string
      enabled: boolean
      model: string
      effort: string
      notify: 'auto' | 'never' | 'always'
      user_message_key: string | null
    }>

    const existing = getDb()
      .prepare('SELECT * FROM webhooks WHERE id = ?')
      .get(req.params.id) as WebhookRow | undefined

    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const updated = {
      name: body.name ?? existing.name,
      prompt: body.prompt ?? existing.prompt,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      model: body.model ?? existing.model ?? 'claude-opus-4-8',
      effort: body.effort !== undefined ? normalizeEffort(body.effort) : existing.effort,
      notify: body.notify ?? existing.notify ?? 'auto',
      user_message_key: body.user_message_key !== undefined ? (body.user_message_key || null) : existing.user_message_key,
    }

    getDb()
      .prepare('UPDATE webhooks SET name=?, prompt=?, enabled=?, model=?, effort=?, notify=?, user_message_key=? WHERE id=?')
      .run(updated.name, updated.prompt, updated.enabled, updated.model, updated.effort, updated.notify, updated.user_message_key, req.params.id)

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
  app.post<{ Params: { token: string }; Querystring: { sync?: string } }>('/:token/trigger', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const row = getDb()
      .prepare('SELECT * FROM webhooks WHERE token = ? AND enabled = 1')
      .get(req.params.token) as WebhookRow | undefined

    if (!row) return reply.code(404).send({ error: 'Not found' })

    const payload = (req.body && typeof req.body === 'object' && Object.keys(req.body as object).length > 0)
      ? req.body
      : undefined

    if (req.query.sync === 'true' || req.query.sync === '1') {
      try {
        const response = await fireWebhookSync(row, payload)
        return { ok: true, webhook: row.name, response }
      } catch (err) {
        return reply.code(504).send({ error: 'Response timeout' })
      }
    }

    fireWebhook(row, payload)
    return { ok: true, webhook: row.name }
  })

  app.post<{ Params: { token: string } }>('/:token/cancel', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const row = getDb()
      .prepare('SELECT * FROM webhooks WHERE token = ? AND enabled = 1')
      .get(req.params.token) as WebhookRow | undefined

    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!row.conversation_id) return reply.code(400).send({ error: 'No active conversation' })

    await cancelConversation(row.conversation_id)
    return { ok: true }
  })
}
