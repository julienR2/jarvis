/**
 * Internal routes — called by the agent via curl skill.
 * Protected by a shared secret (INTERNAL_SECRET env var), NOT by JWT.
 */
import type { FastifyInstance } from 'fastify'
import cron from 'node-cron'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getDb, uuid, normalizeEffort } from '../db.js'
import { processMessage, type Attachment } from './conversations.js'
import { getAllConnectors, getConnector } from '../connectors.js'
import { archiveAppDir } from '../app-archive.js'
import { schedule, rescheduleAll } from '../crons.js'
import { seedFixtures } from '../fixtures.js'
import { getSection, setSectionContext, topicConversations, MAX_CONTEXT_CHARS } from '../topics.js'
import { emitConversationEvent } from '../sse.js'
import { pushForConversation } from '../push.js'
import { config } from '../config.js'
import { secureEquals } from '../security.js'
import type { CronRow, WebhookRow, ConvRow } from '../types.js'

function checkSecret(req: any, reply: any): boolean {
  const auth = req.headers['x-internal-secret']
  if (typeof auth !== 'string' || !secureEquals(auth, config.internalSecret)) {
    reply.code(403).send({ error: 'Forbidden' })
    return false
  }
  return true
}


/**
 * Die in whichever way actually brings us back on the code now on disk.
 * Plain `tsx src/index.ts`: exiting ends the container's `sh -c` chain and the
 * restart policy restarts it. `tsx watch`: the watcher outlives an exited child
 * and waits for a file change — so give it one, a byte-identical rewrite of our
 * own entry file. (Signalling PID 1 is not an option: a non-interactive sh as
 * init ignores SIGTERM.) Delayed so the reply gets out first.
 */
function scheduleRestart(): 'watch' | 'exit' {
  const underWatch = parentIsTsxWatch()
  setTimeout(() => {
    if (underWatch) {
      try {
        const entry = join(process.env.JARVIS_REPO_DIR || '/jarvis', 'backend/src/index.ts')
        writeFileSync(entry, readFileSync(entry))
        return
      } catch (err) {
        console.error('[restart] could not nudge tsx watch, exiting instead:', err)
      }
    }
    process.exit(0)
  }, 300)
  return underWatch ? 'watch' : 'exit'
}

/** True when our parent process is the `tsx watch` supervisor. Linux only, like the container. */
function parentIsTsxWatch(): boolean {
  try {
    const ppid = /PPid:\s*(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]
    if (!ppid) return false
    const cmd = readFileSync(`/proc/${ppid}/cmdline`, 'utf8').split('\0').join(' ')
    return /\btsx\b.*\bwatch\b/.test(cmd)
  } catch {
    return false
  }
}

export async function internalRoutes(app: FastifyInstance) {
  // Restart this backend so it picks up new source. Prod mode runs without a
  // file watcher, so a deploy has to say when.
  //
  // Two ways to die, depending on how we were started. Plain `tsx src/index.ts`:
  // exiting ends the container's `sh -c` chain and the restart policy brings it
  // back on the code now on disk. `tsx watch`: the watcher outlives an exited
  // child and waits for a file change — so give it one, a byte-identical
  // rewrite of our own entry file, and it restarts us itself. (Signalling PID 1
  // is not an option: a non-interactive sh as init ignores SIGTERM.)
  app.post('/restart', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    const mode = scheduleRestart()
    return { ok: true, restarting: true, mode }
  })

  // Wipe this instance's database and come back empty (re-seeded at boot when
  // SEED_FIXTURES is set). Only for throwaway instances — the `next` stack —
  // and only when its compose says so; prod never sets ALLOW_DB_RESET.
  app.post('/reset', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    if (process.env.ALLOW_DB_RESET !== '1') {
      return reply.code(403).send({ error: 'reset is not enabled on this instance' })
    }
    try { getDb().close() } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(config.dbPath + suffix) } catch { /* absent */ }
    }
    const mode = scheduleRestart()
    return { ok: true, reset: true, restarting: true, mode }
  })

  // Put the fixtures back without touching anything else — what the e2e run
  // does before it starts, so it can share the instance with a person using it.
  // Only where fixtures are seeded at all (the `next` stack).
  app.post('/fixtures', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    if (process.env.SEED_FIXTURES !== '1') {
      return reply.code(403).send({ error: 'fixtures are not enabled on this instance' })
    }
    seedFixtures({ rearm: true })
    rescheduleAll()
    return { ok: true, rearmed: true }
  })

  app.post('/crons', async (req, reply) => {
    if (!checkSecret(req, reply)) return

    const body = req.body as {
      name: string
      schedule: string
      prompt: string
      enabled?: boolean
      /** 'high' = think hard; anything else = the model's default. */
      effort?: string | boolean
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
      .prepare('INSERT INTO crons (id, name, schedule, prompt, enabled, once, conversation_id, model, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, body.schedule, body.prompt, body.enabled !== false ? 1 : 0, body.once ? 1 : 0, body.conversation_id || null, null, normalizeEffort(body.effort))

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

  // ── Where am I? ─────────────────────────────────────────────────────────
  //
  // The conversation the agent runs in, with the topic it is filed under —
  // what the `topic` skill reads before updating a brief.
  app.get<{ Params: { id: string } }>('/conversations/:id', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    const conv = getDb()
      .prepare('SELECT id, title, section_id, app_path, created_at, updated_at FROM conversations WHERE id = ?')
      .get(req.params.id) as Pick<ConvRow, 'id' | 'title' | 'section_id' | 'app_path' | 'created_at' | 'updated_at'> | undefined
    if (!conv) return reply.code(404).send({ error: 'Conversation not found' })
    const section = conv.section_id ? getSection(conv.section_id) : undefined
    return {
      ...conv,
      topic: section ? { id: section.id, name: section.name, context: section.context, context_updated_at: section.context_updated_at } : null,
    }
  })

  // ── Topics ──────────────────────────────────────────────────────────────

  app.get('/topics', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    return getDb().prepare('SELECT id, name, context, context_updated_at FROM sections ORDER BY position ASC, created_at ASC').all()
  })

  app.get<{ Params: { id: string } }>('/topics/:id', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    const section = getSection(req.params.id)
    if (!section) return reply.code(404).send({ error: 'Topic not found' })
    return { ...section, conversations: topicConversations(section.id) }
  })

  // Rewrite a topic's brief. The whole text, not a patch: the brief is meant
  // to be re-read and re-written as one piece, which is also what keeps it
  // short.
  app.patch<{ Params: { id: string } }>('/topics/:id/context', async (req, reply) => {
    if (!checkSecret(req, reply)) return
    const { context } = (req.body ?? {}) as { context?: unknown }
    if (typeof context !== 'string') return reply.code(400).send({ error: 'context (string) is required' })
    if (context.length > MAX_CONTEXT_CHARS * 2) {
      return reply.code(400).send({ error: `context is too long (max ${MAX_CONTEXT_CHARS} characters)` })
    }
    const section = setSectionContext(req.params.id, context)
    if (!section) return reply.code(404).send({ error: 'Topic not found' })
    return { ok: true, topic: { id: section.id, name: section.name, context: section.context, context_updated_at: section.context_updated_at } }
  })

  // ── Conversation history ───────────────────────────────────────────────
  //
  // Read back what was said in a conversation.
  //
  // The CLI carries its own transcript, but it is gone whenever the session is
  // replaced without a resume — crossing between Anthropic and a gateway does
  // exactly that, and a cron pinned to a cheap model on one provider posting
  // into a chat you continue on the other is the ordinary way to hit it. The
  // messages are still in Jarvis's database either way, so this is how the
  // agent reads what it can no longer remember, rather than answering from the
  // shape of the question.
  //
  // Newest-first in SQL so LIMIT takes the recent end, returned oldest-first
  // because that is the order it reads in.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/conversations/:id/messages',
    async (req, reply) => {
      if (!checkSecret(req, reply)) return

      const conv = getDb()
        .prepare('SELECT id, title FROM conversations WHERE id = ?')
        .get(req.params.id) as { id: string; title: string } | undefined
      if (!conv) return reply.code(404).send({ error: 'Conversation not found' })

      const asked = Number(req.query.limit)
      const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 20, 1), 100)

      const rows = getDb()
        .prepare(
          `SELECT role, content, metadata, created_at
             FROM messages
            WHERE conversation_id = ?
              AND type IS NULL
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?`,
        )
        .all(req.params.id, limit) as {
        role: string
        content: string
        metadata: string | null
        created_at: number
      }[]

      // A single turn can run to tens of kilobytes once its reasoning is
      // included. Capped per message so asking for history can't blow up the
      // context it was meant to restore.
      const MAX_CHARS = 2000

      const messages = rows.reverse().map((r) => {
        const full = r.content ?? ''
        let attachments: string[] = []
        try {
          const meta = r.metadata ? JSON.parse(r.metadata) : null
          attachments = (meta?.attachments ?? []).map(
            (a: { originalName?: string; url?: string }) => a.originalName || a.url || 'file',
          )
        } catch {
          /* metadata that won't parse simply has no attachments to report */
        }
        return {
          role: r.role,
          at: new Date(r.created_at * 1000).toISOString(),
          content: full.length > MAX_CHARS ? full.slice(0, MAX_CHARS) : full,
          truncated: full.length > MAX_CHARS,
          ...(attachments.length ? { attachments } : {}),
        }
      })

      return { conversation_id: conv.id, title: conv.title, count: messages.length, messages }
    },
  )

  // Post into a conversation the agent is not currently running in.
  //
  // The owner-facing POST /api/conversations/:id/messages needs a JWT, which the
  // agent has no way to obtain — so relaying something into another chat used to
  // mean a one-shot cron pinned a few minutes out. This is the same call behind
  // the shared secret: the message lands as a user turn and the target
  // conversation answers it, immediately and with no cron row left behind.
  app.post<{ Params: { id: string } }>(
    '/conversations/:id/messages',
    async (req, reply) => {
      if (!checkSecret(req, reply)) return

      const { content, attachments } = req.body as {
        content?: string
        attachments?: Attachment[]
      }

      const conv = getDb()
        .prepare('SELECT * FROM conversations WHERE id = ?')
        .get(req.params.id) as ConvRow | undefined
      if (!conv) return reply.code(404).send({ error: 'Conversation not found' })

      if (!content?.trim() && !attachments?.length) {
        return reply.code(400).send({ error: 'Empty message' })
      }

      const id = processMessage(
        req.params.id,
        conv,
        content?.trim() || '',
        attachments || [],
        { model: conv.model ?? undefined, effort: normalizeEffort(conv.effort) },
      )

      return { id, conversation_id: conv.id, title: conv.title }
    },
  )

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
      effort?: string | boolean
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
      .prepare('INSERT INTO webhooks (id, name, token, prompt, enabled, conversation_id, model, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, body.name, token, body.prompt, body.enabled !== false ? 1 : 0, body.conversation_id || null, null, normalizeEffort(body.effort))

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

    await pushForConversation(conversation_id, title || conv.title, body || '')

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
