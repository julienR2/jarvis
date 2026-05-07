/**
 * Internal routes — called by the agent via curl skill.
 * Protected by a shared secret (INTERNAL_SECRET env var), NOT by JWT.
 */
import type { FastifyInstance } from 'fastify'
import cron from 'node-cron'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { getDb, uuid } from '../db.js'
import { schedule, rescheduleAll } from '../crons.js'
import { emitConversationEvent } from '../sse.js'
import { sendPushToAll } from '../push.js'
import { config } from '../config.js'
import type { CronRow, WebhookRow, ConvRow } from '../types.js'

function checkSecret(req: any, reply: any): boolean {
  const auth = req.headers['x-internal-secret']
  if (auth !== config.internalSecret) {
    reply.code(403).send({ error: 'Forbidden' })
    return false
  }
  return true
}

export async function internalRoutes(app: FastifyInstance) {
  app.post('/crons', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const body = req.body as {
      name: string
      schedule: string
      prompt: string
      enabled?: boolean
      once?: boolean
      conversation_id?: string
    }

    if (!body.name || !body.schedule || !body.prompt) {
      return reply.code(400).send({ error: 'name, schedule, and prompt are required' })
    }
    if (!cron.validate(body.schedule)) {
      return reply.code(400).send({ error: `Invalid cron expression: ${body.schedule}` })
    }

    // Upsert by name
    const existing = getDb()
      .prepare('SELECT * FROM crons WHERE name = ?')
      .get(body.name) as CronRow | undefined

    if (existing) {
      getDb()
        .prepare('UPDATE crons SET schedule=?, prompt=?, enabled=?, once=? WHERE id=?')
        .run(
          body.schedule,
          body.prompt,
          body.enabled !== false ? 1 : 0,
          body.once ? 1 : 0,
          existing.id,
        )
      const row = getDb().prepare('SELECT * FROM crons WHERE id = ?').get(existing.id) as CronRow
      schedule(row)
      return { updated: true, cron: row }
    }

    const id = uuid()
    getDb()
      .prepare('INSERT INTO crons (id, name, schedule, prompt, enabled, once, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, body.schedule, body.prompt, body.enabled !== false ? 1 : 0, body.once ? 1 : 0, body.conversation_id || null)

    const row = getDb().prepare('SELECT * FROM crons WHERE id = ?').get(id) as CronRow
    schedule(row)
    return { created: true, cron: row }
  })

  app.delete<{ Params: { name: string } }>('/crons/:name', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const result = getDb()
      .prepare('DELETE FROM crons WHERE name = ?')
      .run(req.params.name)

    if (result.changes === 0) return reply.code(404).send({ error: 'Cron not found' })
    rescheduleAll()
    return { ok: true }
  })

  app.get('/crons', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    return getDb().prepare('SELECT * FROM crons ORDER BY created_at ASC').all()
  })

  // ── Webhooks ───────────────────────────────────────────────────────────

  app.get('/webhooks', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    return getDb().prepare('SELECT * FROM webhooks ORDER BY created_at ASC').all()
  })

  app.post('/webhooks', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const body = req.body as {
      name: string
      prompt: string
      enabled?: boolean
      conversation_id?: string
    }

    if (!body.name || !body.prompt) {
      return reply.code(400).send({ error: 'name and prompt are required' })
    }

    // Upsert by name
    const existing = getDb()
      .prepare('SELECT * FROM webhooks WHERE name = ?')
      .get(body.name) as WebhookRow | undefined

    if (existing) {
      getDb()
        .prepare('UPDATE webhooks SET prompt=?, enabled=? WHERE id=?')
        .run(body.prompt, body.enabled !== false ? 1 : 0, existing.id)
      const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(existing.id)
      return { updated: true, webhook: row }
    }

    const id = uuid()
    const token = uuid()
    getDb()
      .prepare('INSERT INTO webhooks (id, name, token, prompt, enabled, conversation_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, body.name, token, body.prompt, body.enabled !== false ? 1 : 0, body.conversation_id || null)

    const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id)
    return { created: true, webhook: row }
  })

  app.delete<{ Params: { name: string } }>('/webhooks/:name', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const result = getDb()
      .prepare('DELETE FROM webhooks WHERE name = ?')
      .run(req.params.name)

    if (result.changes === 0) return reply.code(404).send({ error: 'Webhook not found' })
    return { ok: true }
  })

  // ── Notify (for auto-notify conversations) ──────────────────────────────

  app.post('/notify', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const { conversation_id, title, body } = req.body as {
      conversation_id?: string
      title?: string
      body?: string
    }

    if (!conversation_id) {
      return reply.code(400).send({ error: 'conversation_id is required' })
    }

    const conv = getDb()
      .prepare('SELECT id, title FROM conversations WHERE id = ?')
      .get(conversation_id) as ConvRow | undefined

    if (!conv) {
      return reply.code(404).send({ error: 'Conversation not found' })
    }

    await sendPushToAll(
      title || conv.title,
      body || '',
      `/c/${conversation_id}`,
    )

    return { ok: true }
  })

  // ── Mini-apps ────────────────────────────────────────────────────────────

  app.post('/mini-apps', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const body = req.body as { conversation_id: string }
    if (!body.conversation_id) {
      return reply.code(400).send({ error: 'conversation_id is required' })
    }

    const conv = getDb()
      .prepare('SELECT id FROM conversations WHERE id = ?')
      .get(body.conversation_id) as ConvRow | undefined

    if (!conv) {
      return reply.code(404).send({ error: 'Conversation not found' })
    }

    const appDir = join(config.workspaceDir, 'mini-apps', body.conversation_id)
    mkdirSync(appDir, { recursive: true })

    getDb()
      .prepare('UPDATE conversations SET mini_app_path = ? WHERE id = ?')
      .run(`mini-apps/${body.conversation_id}`, body.conversation_id)

    return { ok: true, path: `/jarvis/workspace/mini-apps/${body.conversation_id}` }
  })

  app.post<{ Params: { conversationId: string } }>('/mini-apps/:conversationId/notify', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    emitConversationEvent(req.params.conversationId, { type: 'mini_app_updated' })
    return { ok: true }
  })

  app.delete<{ Params: { conversationId: string } }>('/mini-apps/:conversationId', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const { conversationId } = req.params
    const conv = getDb()
      .prepare('SELECT id, mini_app_path FROM conversations WHERE id = ?')
      .get(conversationId) as ConvRow | undefined

    if (!conv) return reply.code(404).send({ error: 'Conversation not found' })

    // Remove mini-app files
    const appDir = join(config.workspaceDir, 'mini-apps', conversationId)
    if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true })

    // Clear mini_app_path on the conversation
    getDb()
      .prepare('UPDATE conversations SET mini_app_path = NULL, updated_at = unixepoch() WHERE id = ?')
      .run(conversationId)

    return { ok: true }
  })
}
