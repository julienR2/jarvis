import type { FastifyInstance } from 'fastify'
import { getDb, uuid, normalizeEffort } from '../db.js'
import { fireWebhook, fireWebhookSync } from '../webhooks.js'
import { stopRunsFor } from '../runs.js'
import { ensureThread, setThreadNotify, syncThreadParent, renameThread, threadNotifyOf } from '../threads.js'
import type { WebhookRow } from '../types.js'

function conversationExists(id: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)
}

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
      /** The chat the runs report into. Omitted: the thread stands alone. */
      conversation_id?: string | null
    }

    if (!body.name || !body.prompt) {
      return reply.code(400).send({ error: 'name and prompt are required' })
    }
    if (body.conversation_id && !conversationExists(body.conversation_id)) {
      return reply.code(400).send({ error: 'Unknown conversation' })
    }

    const id = uuid()
    const token = uuid()
    const enabled = body.enabled !== false ? 1 : 0
    const model = body.model ?? null // null → global default (resolved at fire time)
    const effort = normalizeEffort(body.effort)
    const notify = body.notify ?? 'auto'
    const user_message_key = body.user_message_key ?? null

    getDb()
      .prepare('INSERT INTO webhooks (id, name, token, prompt, enabled, model, effort, notify, user_message_key, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, token, body.prompt, enabled, model, effort, notify, user_message_key, body.conversation_id || null)

    const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow
    ensureThread('webhooks', row, threadNotifyOf(notify))
    return row
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
      conversation_id: string | null
    }>

    const existing = getDb()
      .prepare('SELECT * FROM webhooks WHERE id = ?')
      .get(req.params.id) as WebhookRow | undefined

    if (!existing) return reply.code(404).send({ error: 'Not found' })
    if (body.conversation_id && !conversationExists(body.conversation_id)) {
      return reply.code(400).send({ error: 'Unknown conversation' })
    }

    const updated = {
      name: body.name ?? existing.name,
      prompt: body.prompt ?? existing.prompt,
      enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      model: body.model ?? existing.model ?? null,
      effort: body.effort !== undefined ? normalizeEffort(body.effort) : existing.effort,
      notify: body.notify ?? existing.notify ?? 'auto',
      user_message_key: body.user_message_key !== undefined ? (body.user_message_key || null) : existing.user_message_key,
      conversation_id: 'conversation_id' in body ? (body.conversation_id || null) : existing.conversation_id,
    }

    getDb()
      .prepare('UPDATE webhooks SET name=?, prompt=?, enabled=?, model=?, effort=?, notify=?, user_message_key=?, conversation_id=? WHERE id=?')
      .run(updated.name, updated.prompt, updated.enabled, updated.model, updated.effort, updated.notify, updated.user_message_key, updated.conversation_id, req.params.id)

    const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id) as WebhookRow
    syncThreadParent(row.thread_id, row.conversation_id)
    renameThread(row.thread_id, existing.name, row.name)
    if (body.notify) setThreadNotify(row.thread_id, threadNotifyOf(body.notify))
    return row
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
    if (!row.thread_id) return reply.code(400).send({ error: 'No active conversation' })

    // Its runs happen in its thread, each under its own session.
    await stopRunsFor(row.thread_id)
    return { ok: true }
  })
}
