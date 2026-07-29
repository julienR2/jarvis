/**
 * Internal routes — called by the agent via curl skill.
 * Protected by a shared secret (INTERNAL_SECRET env var), NOT by JWT.
 */
import type { FastifyInstance } from 'fastify'
import cron from 'node-cron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { getDb, uuid } from '../db.js'
import { getAllConnectors, getConnector } from '../connectors.js'
import { archiveAppDir } from '../app-archive.js'
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
        .prepare('UPDATE crons SET schedule=?, prompt=?, enabled=?, once=?, conversation_id=COALESCE(?, conversation_id) WHERE id=?')
        .run(
          body.schedule,
          body.prompt,
          body.enabled !== false ? 1 : 0,
          body.once ? 1 : 0,
          body.conversation_id ?? null,
          existing.id,
        )
      const row = getDb().prepare('SELECT * FROM crons WHERE id = ?').get(existing.id) as CronRow
      schedule(row)
      return { updated: true, cron: row }
    }

    const id = uuid()
    getDb()
      // model = null → "use the global default" (resolved at fire time); never
      // rely on the column default, which may be a stale value on older DBs.
      .prepare('INSERT INTO crons (id, name, schedule, prompt, enabled, once, conversation_id, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, body.schedule, body.prompt, body.enabled !== false ? 1 : 0, body.once ? 1 : 0, body.conversation_id || null, null)

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
      // model = null → "use the global default" (resolved at fire time)
      .prepare('INSERT INTO webhooks (id, name, token, prompt, enabled, conversation_id, model) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, token, body.prompt, body.enabled !== false ? 1 : 0, body.conversation_id || null, null)

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

  // ── Apps ─────────────────────────────────────────────────────────────────

  app.post('/apps', async (req, reply) => {
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

    const appDir = join(config.workspaceDir, 'apps', body.conversation_id)
    mkdirSync(appDir, { recursive: true })

    getDb()
      .prepare('UPDATE conversations SET app_path = ? WHERE id = ?')
      .run(`apps/${body.conversation_id}`, body.conversation_id)

    return { ok: true, path: appDir }
  })

  app.post<{ Params: { conversationId: string } }>('/apps/:conversationId/notify', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    emitConversationEvent(req.params.conversationId, { type: 'app_updated' })
    return { ok: true }
  })

  // ── Transcribe (Whisper only) ──────────────────────────────────────────────
  //
  // Stateless speech-to-text for external integrations (e.g. the Telegram
  // "transcribe this audio" bot driven by n8n). n8n can't reach the whisper
  // container directly — it lives on a different Docker network — but it can
  // reach the backend, which proxies the upload to whisper:9000. Language is
  // auto-detected. Returns { transcript }.
  app.post('/transcribe', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const file = await req.file()
    if (!file) {
      return reply.code(400).send({ error: 'No audio file (send multipart field "audio_file")' })
    }

    const buffer = await file.toBuffer()
    const blob = new Blob([new Uint8Array(buffer)], {
      type: file.mimetype || 'application/octet-stream',
    })
    const form = new FormData()
    form.append('audio_file', blob, file.filename || 'audio')

    let whisperRes: Response
    try {
      whisperRes = await fetch(`${config.whisperUrl}/asr?task=transcribe&output=txt`, {
        method: 'POST',
        body: form,
      })
    } catch (err) {
      return reply.code(502).send({ error: `Whisper unreachable: ${(err as Error).message}` })
    }

    if (!whisperRes.ok) {
      return reply.code(502).send({ error: `Transcription failed: ${whisperRes.status}` })
    }

    const transcript = (await whisperRes.text()).trim()
    return { transcript }
  })

  app.delete<{ Params: { conversationId: string } }>('/apps/:conversationId', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const { conversationId } = req.params
    const conv = getDb()
      .prepare('SELECT id, app_path FROM conversations WHERE id = ?')
      .get(conversationId) as ConvRow | undefined

    if (!conv) return reply.code(404).send({ error: 'Conversation not found' })

    // Archive the app files (instead of deleting) so they can be recovered.
    archiveAppDir(conversationId, (conv as any).app_path)

    getDb()
      .prepare('UPDATE conversations SET app_path = NULL, updated_at = unixepoch() WHERE id = ?')
      .run(conversationId)

    return { ok: true }
  })

  // ── Connectors (for skills) ────────────────────────────────────────────────
  // Skills fetch credentials on demand instead of reading injected env vars.

  // GET /connectors — inventory: every connector + its field labels, NO values.
  app.get('/connectors', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    return getAllConnectors().map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      hasProxy: !!c.proxy,
      fields: c.fields.map(({ key, label }) => ({ key, label })),
    }))
  })

  // GET /connectors/:id — one connector's field values, plus a flat `env`
  // convenience map keyed by field key (e.g. `jq -r .env.GMAIL_APP_PASSWORD`).
  app.get<{ Params: { id: string } }>('/connectors/:id', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    const conn = getConnector(req.params.id)
    if (!conn) return reply.code(404).send({ error: 'Unknown connector' })
    const env: Record<string, string> = {}
    for (const f of conn.fields) env[f.key] = f.value
    return {
      id: conn.id,
      name: conn.name,
      description: conn.description,
      fields: conn.fields.map(({ key, label, value }) => ({ key, label, value })),
      env,
    }
  })
}
