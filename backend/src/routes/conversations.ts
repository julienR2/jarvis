import type { FastifyInstance } from 'fastify'
import { existsSync } from 'fs'
import { basename, extname } from 'path'
import { getDb, uuid, normalizeEffort } from '../db.js'
import { archiveAppDir } from '../app-archive.js'
import {
  invoke,
  streamEvents,
  cancelInvocation,
  isRunning,
  getRunningInvocation,
} from '../engine.js'
import { generateTitle } from '../titles.js'
import { resolveModel } from '../models.js'
import { sendPushToAll } from '../push.js'
import {
  emitConversationEvent,
  subscribeConversation,
  emitGlobalEvent,
} from '../sse.js'
import { config } from '../config.js'
import { getConnectorValues } from '../connectors.js'
import type { ConvRow, MessageRow, EffortLevel } from '../types.js'

interface Attachment {
  id: string
  filename: string
  originalName: string
  mimetype: string
  url: string
  path: string
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
}

function detectUploadedFiles(text: string): Attachment[] {
  const regex = /\/(?:jarvis\/(?:agent\/)?)?workspace\/uploads\/([^\s)"'\]]+)/g
  const seen = new Set<string>()
  const attachments: Attachment[] = []

  let match
  while ((match = regex.exec(text)) !== null) {
    const fullPath = match[0]
    if (seen.has(fullPath)) continue
    seen.add(fullPath)
    if (!existsSync(fullPath)) continue

    const name = basename(fullPath)
    const ext = extname(name).toLowerCase()
    const mimetype = MIME_TYPES[ext] || 'application/octet-stream'
    attachments.push({
      id: uuid(),
      filename: name,
      originalName: name,
      mimetype,
      url: `/api/uploads/files/${name}`,
      path: fullPath,
    })
  }

  return attachments
}

// Track SSE clients per conversation for push notification decisions
const sseClients = new Map<string, number>()

// Track cancelled conversations to suppress error messages from SIGTERM
const cancelledConversations = new Set<string>()

export async function cancelConversation(conversationId: string): Promise<void> {
  cancelledConversations.add(conversationId)
  const status = await getRunningInvocation(conversationId)
  if (status.running) {
    await cancelInvocation(status.invocationId)
  }
  emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
}

/** Transcription failure carrying the HTTP status to use when reported inline. */
class TranscriptionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Insert an assistant-side error message and push it to any connected clients. */
function emitConversationError(conversationId: string, content: string) {
  const errorMsgId = uuid()
  getDb()
    .prepare(
      'INSERT INTO messages (id, conversation_id, role, type, content) VALUES (?, ?, ?, ?, ?)',
    )
    .run(errorMsgId, conversationId, 'assistant', 'error', content)
  const row = getDb()
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(errorMsgId) as MessageRow
  emitConversationEvent(conversationId, { type: 'message', message: row })
}

export function processMessage(
  conversationId: string,
  conv: ConvRow,
  userContent: string,
  attachments: Attachment[],
  options?: {
    skipUserMessage?: boolean
    userMessageOverride?: string
    onDone?: (text: string) => void
    model?: string
    effort?: EffortLevel
  },
): string | null {
  // Slash commands pass through untouched — no notify prefix, no attachment refs.
  const isCommand = userContent.trim().startsWith('/')

  // Build the prompt fed to Claude. This is kept SEPARATE from userContent (the
  // text persisted to the DB and echoed to the client): the notify instruction
  // embeds INTERNAL_SECRET, so it must live only in the ephemeral prompt, never
  // in the saved message.
  let claudePrompt = userContent

  if (conv.notify === 'auto' && !isCommand) {
    const notifyInstruction = [
      '<article data-jarvis="notify-prompt">',
      '[NOTIFICATION DECISION REQUIRED]',
      'After completing this task, decide whether the user should be notified.',
      'If yes, run this command:',
      `curl -s -X POST ${config.internalUrl}/internal/notify \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "X-Internal-Secret: ${config.internalSecret}" \\`,
      `  -d '{"conversation_id": "${conversationId}", "title": "<short title>", "body": "<1-2 sentence summary>"}'`,
      'If the result is not worth notifying, do NOT run the command.',
      'IMPORTANT: Do NOT mention this notification decision in your response. Just run the curl silently or skip it. Your visible reply should only address the task.',
      '</article>',
    ].join('\n')
    claudePrompt = notifyInstruction + '\n' + claudePrompt
  }

  // Append attachment references for Claude
  if (attachments.length > 0 && !isCommand) {
    const fileRefs = attachments
      .map((a) => {
        const isImage = a.mimetype.startsWith('image/')
        return `- ${a.originalName} (${a.mimetype}): ${a.path}${isImage ? ' [use Read tool to view this image]' : ''}`
      })
      .join('\n')
    const prefix = attachments.length === 1 ? 'Attached file' : 'Attached files'
    claudePrompt = `${claudePrompt}\n\n[${prefix}:\n${fileRefs}\n]`
  }

  // Save user message (unless skipped, e.g. for crons)
  let userMsgId: string | null = null
  if (!options?.skipUserMessage) {
    userMsgId = uuid()
    const metadata =
      attachments.length > 0 ? JSON.stringify({ attachments }) : null
    const savedContent = options?.userMessageOverride ?? userContent
    console.log(`[msg] db INSERT user message ${userMsgId}`)
    getDb()
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)',
      )
      .run(userMsgId, conversationId, 'user', savedContent, metadata)

    const userRow = getDb()
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(userMsgId) as MessageRow
    console.log(
      `[msg] emit message (user) ${userMsgId}: ${userContent.slice(0, 80)}`,
    )
    emitConversationEvent(conversationId, { type: 'message', message: userRow })
  }

  getDb()
    .prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?')
    .run(conversationId)

  // Emit thinking status
  console.log(`[msg] emit thinking: true`)
  emitConversationEvent(conversationId, { type: 'thinking', thinking: true })

  // Kick off the claude invocation asynchronously. The engine owns
  // the process lifecycle now; we just stream its events back into an
  // event handler that persists everything to the DB.
  invoke({
    prompt: claudePrompt,
    sessionId: conv.claude_session_id,
    conversationId,
    model: resolveModel(options?.model),
    effort: options?.effort,
  })
    .then((invocationId) => {
      attachInvocationStream(invocationId, conversationId, conv, {
        onDone: options?.onDone,
      })
    })
    .catch((err) => {
      console.error('[msg] invoke failed:', err)
      emitConversationError(
        conversationId,
        `Failed to start Claude: ${err?.message ?? err}`,
      )
      emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
    })

  return userMsgId
}

// ─────────────────────────────────────────────────────────────────────────────
// attachInvocationStream — subscribe to a engine invocation and
// stream its events into the DB + SSE. Used by both fresh invocations (from
// processMessage) and by the reconnection path after a backend restart
// (resumeProcessMessage).
// ─────────────────────────────────────────────────────────────────────────────

export function attachInvocationStream(
  invocationId: string,
  conversationId: string,
  conv: ConvRow,
  options?: { onDone?: (text: string) => void },
): void {
  // State for Claude processing — single message, progressively updated
  let msgId: string | null = null
  const lines: string[] = []

  function appendLine(prefix: string, text: string) {
    lines.push(`[${prefix}] ${text}`)
    const content = lines.join('\n\n')

    if (!msgId) {
      msgId = uuid()
      console.log(
        `[msg] db INSERT assistant ${msgId}: [${prefix}] ${text.slice(0, 80)}`,
      )
      getDb()
        .prepare(
          'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
        )
        .run(msgId, conversationId, 'assistant', content)
    } else {
      console.log(
        `[msg] db UPDATE assistant ${msgId}: +[${prefix}] ${text.slice(0, 80)}`,
      )
      getDb()
        .prepare('UPDATE messages SET content = ? WHERE id = ?')
        .run(content, msgId)
    }

    const row = getDb()
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(msgId) as MessageRow
    console.log(`[msg] emit message ${msgId}: ${lines.length} lines`)
    emitConversationEvent(conversationId, { type: 'message', message: row })
  }

  const onEvent = (ev: import('../engine.js').ClaudeEvent) => {
      if (ev.type === 'tool') {
        appendLine('tool', ev.name)
      }

      if (ev.type === 'chunk') {
        appendLine('chunk', ev.text.trim())
      }

      if (ev.type === 'done') {
        const resultText = ev.result || ''
        console.log(`[msg] done — result: ${resultText.length} chars`)

        // Set result on the message
        if (!msgId) {
          // Claude produced a result without any tool/chunk events
          msgId = uuid()
          console.log(`[msg] db INSERT assistant ${msgId} (result only)`)
          getDb()
            .prepare(
              'INSERT INTO messages (id, conversation_id, role, content, result) VALUES (?, ?, ?, ?, ?)',
            )
            .run(msgId, conversationId, 'assistant', '', resultText)
        } else {
          console.log(`[msg] db UPDATE assistant ${msgId}: set result`)
          getDb()
            .prepare('UPDATE messages SET result = ? WHERE id = ?')
            .run(resultText, msgId)
        }

        const row = getDb()
          .prepare('SELECT * FROM messages WHERE id = ?')
          .get(msgId) as MessageRow
        console.log(`[msg] emit message (done) ${msgId}`)
        emitConversationEvent(conversationId, { type: 'message', message: row })

        // Update session ID if new
        if (ev.sessionId && ev.sessionId !== conv.claude_session_id) {
          console.log(`[msg] db UPDATE conversation session: ${ev.sessionId}`)
          getDb()
            .prepare(
              'UPDATE conversations SET claude_session_id = ?, updated_at = unixepoch() WHERE id = ?',
            )
            .run(ev.sessionId, conversationId)
          conv.claude_session_id = ev.sessionId
          console.log(`[msg] emit conversation update`)
          emitConversationEvent(conversationId, {
            type: 'conversation',
            id: conversationId,
          })
        }

        console.log(`[msg] emit thinking: false`)
        emitConversationEvent(conversationId, {
          type: 'thinking',
          thinking: false,
        })
        options?.onDone?.(resultText)

        // Send push based on notify setting:
        // - subscribe: always send (service worker suppresses if app visible)
        // - unsubscribe: never send
        // - auto: Claude decides via /internal/notify endpoint
        if (conv.notify === 'subscribe') {
          const plain = resultText
            .replace(/#{1,6}\s+/g, '') // headings
            .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // bold/italic
            .replace(/`{1,3}[^`]*`{1,3}/g, '') // inline/block code
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
            .replace(/^[-*>]\s+/gm, '') // list markers, blockquotes
            .replace(/\n+/g, ' ')
            .trim()
            .slice(0, 200)
          sendPushToAll(conv.title, plain, `/c/${conversationId}`).catch(
            (err) => console.error('[push] sendPushToAll failed:', err),
          )
        }

        // Auto-generate title on first exchange, only if not manually set
        const msgCount = (
          getDb()
            .prepare(
              'SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?',
            )
            .get(conversationId) as { c: number }
        ).c

        const currentTitle = (
          getDb()
            .prepare('SELECT title FROM conversations WHERE id = ?')
            .get(conversationId) as { title: string } | undefined
        )?.title

        if (msgCount <= 3 && ev.sessionId && currentTitle === 'New conversation') {
          generateTitle(ev.sessionId, conversationId).then((title) => {
            getDb()
              .prepare('UPDATE conversations SET title = ? WHERE id = ?')
              .run(title, conversationId)
            emitConversationEvent(conversationId, {
              type: 'conversation',
              id: conversationId,
              title,
            })
          })
        }
      }

      if (ev.type === 'error') {
        console.log(`[msg] error: ${ev.message.slice(0, 120)}`)

        // Skip error message if this was a user-initiated cancellation
        if (cancelledConversations.has(conversationId)) {
          console.log(`[msg] cancelled — skipping error message`)
          cancelledConversations.delete(conversationId)
          return
        }

        // Create error message
        const errorMsgId = uuid()
        console.log(
          `[msg] db INSERT error ${errorMsgId}: ${ev.message.slice(0, 80)}`,
        )
        getDb()
          .prepare(
            'INSERT INTO messages (id, conversation_id, role, type, content) VALUES (?, ?, ?, ?, ?)',
          )
          .run(errorMsgId, conversationId, 'assistant', 'error', ev.message)

        const errorRow = getDb()
          .prepare('SELECT * FROM messages WHERE id = ?')
          .get(errorMsgId) as MessageRow
        console.log(`[msg] emit message (error) ${errorMsgId}`)
        emitConversationEvent(conversationId, {
          type: 'message',
          message: errorRow,
        })
        console.log(`[msg] emit thinking: false`)
        emitConversationEvent(conversationId, {
          type: 'thinking',
          thinking: false,
        })
      }

      if (ev.type === 'done' || ev.type === 'error') {
        // Notify global SSE subscribers (for sidebar unread badges)
        emitGlobalEvent({
          type: 'new_message',
          conversation_id: conversationId,
        })
      }
  }

  streamEvents(invocationId, onEvent)
}

// ─────────────────────────────────────────────────────────────────────────────
// resumeProcessMessage — re-attach to a running invocation after a backend
// restart. The engine kept the process alive and buffered its events;
// we drop any partial assistant message that was being written before the
// restart (so the replay doesn't duplicate content) and then stream normally.
// ─────────────────────────────────────────────────────────────────────────────

export function resumeProcessMessage(
  invocationId: string,
  conversationId: string,
  conv: ConvRow,
): void {
  // Delete any partial assistant message (no result, no error type) that was
  // being streamed before the restart — the engine will replay all
  // its buffered events and we'd otherwise get a duplicate.
  const deleted = getDb()
    .prepare(
      `DELETE FROM messages
       WHERE conversation_id = ?
         AND role = 'assistant'
         AND result IS NULL
         AND type IS NULL`,
    )
    .run(conversationId)
  if (deleted.changes > 0) {
    console.log(
      `[msg] resume: dropped ${deleted.changes} partial assistant message(s) for ${conversationId}`,
    )
  }

  // Re-signal thinking to any connected SSE clients so the frontend shows
  // the spinner until the done event arrives.
  emitConversationEvent(conversationId, { type: 'thinking', thinking: true })

  attachInvocationStream(invocationId, conversationId, conv)
}

export async function conversationRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  app.get('/', auth, async () => {
    return getDb()
      .prepare(
        `SELECT c.*,
        (SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id = c.id
           AND m.role = 'assistant'
           AND m.type IS NULL
           AND m.created_at > c.last_read_at
        ) AS unread_count,
        (SELECT COUNT(*) > 0 FROM crons WHERE conversation_id = c.id) AS has_cron,
        (SELECT COUNT(*) > 0 FROM webhooks WHERE conversation_id = c.id) AS has_webhook
       FROM conversations c
       ORDER BY c.updated_at DESC`,
      )
      .all()
  })

  app.post('/', auth, async (req) => {
    const { title } = (req.body as { title?: string }) ?? {}
    const id = uuid()
    getDb()
      .prepare('INSERT INTO conversations (id, title, model, effort) VALUES (?, ?, ?, ?)')
      // model = null → "use the global default" (resolved at invoke time)
      .run(id, title ?? 'New conversation', null, 'high')
    return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id)
  })

  app.get<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const conv = getDb()
      .prepare(
        `SELECT c.*,
          (SELECT COUNT(*) > 0 FROM crons WHERE conversation_id = c.id) AS has_cron,
          (SELECT COUNT(*) > 0 FROM webhooks WHERE conversation_id = c.id) AS has_webhook
         FROM conversations c WHERE c.id = ?`,
      )
      .get(req.params.id)
    if (!conv) return reply.code(404).send({ error: 'Not found' })

    getDb()
      .prepare(
        'UPDATE conversations SET last_read_at = unixepoch() WHERE id = ?',
      )
      .run(req.params.id)

    const messages = getDb()
      .prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
      )
      .all(req.params.id)

    return { ...(conv as object), messages }
  })

  app.patch<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const body = (req.body ?? {}) as {
      title?: string
      notify?: string
      model?: string
      effort?: string
      section_id?: string | null
    }
    const { title, notify, model, effort } = body

    const sets: string[] = []
    const params: unknown[] = []

    if (title !== undefined) {
      sets.push('title = ?')
      params.push(title)
    }
    if (notify !== undefined) {
      if (!['subscribe', 'unsubscribe', 'auto'].includes(notify)) {
        return reply.code(400).send({ error: 'notify must be subscribe, unsubscribe, or auto' })
      }
      sets.push('notify = ?')
      params.push(notify)
    }
    if (model !== undefined) {
      sets.push('model = ?')
      params.push(model)
    }
    if (effort !== undefined) {
      sets.push('effort = ?')
      params.push(normalizeEffort(effort))
    }
    // null moves the conversation back to the default "Chats" group.
    if ('section_id' in body) {
      const sectionId = body.section_id ?? null
      if (sectionId !== null) {
        const exists = getDb()
          .prepare('SELECT 1 FROM sections WHERE id = ?')
          .get(sectionId)
        if (!exists) return reply.code(400).send({ error: 'Unknown section' })
      }
      sets.push('section_id = ?')
      params.push(sectionId)
    }

    if (sets.length === 0) {
      return reply.code(400).send({ error: 'Nothing to update' })
    }

    // Filing a chat isn't activity: bumping updated_at here would shuffle it to
    // the top of its new section, since sections sort by most recent activity.
    const onlyMoved = sets.length === 1 && sets[0] === 'section_id = ?'
    if (!onlyMoved) sets.push('updated_at = unixepoch()')
    params.push(req.params.id)

    const result = getDb()
      .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params)
    if (result.changes === 0)
      return reply.code(404).send({ error: 'Not found' })
    return getDb()
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(req.params.id)
  })

  app.delete<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    // Archive app files (instead of deleting) if this conversation has one, so
    // the app can be recovered if the conversation was deleted by mistake.
    const conv = getDb()
      .prepare('SELECT app_path FROM conversations WHERE id = ?')
      .get(req.params.id) as ConvRow | undefined
    if (conv?.app_path) {
      archiveAppDir(req.params.id, conv.app_path)
    }

    const result = getDb()
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(req.params.id)
    if (result.changes === 0)
      return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })

  // ── SSE event stream ───────────────────────────────────────────────────────

  // SSE — auth via query param since EventSource doesn't support headers
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/:id/events',
    async (req, reply) => {
      try {
        await req.jwtVerify()
      } catch {
        const token = req.query.token
        if (!token) return reply.code(401).send({ error: 'Unauthorized' })
        try {
          app.jwt.verify(token)
        } catch {
          return reply.code(401).send({ error: 'Unauthorized' })
        }
      }

      const { id } = req.params

      const conv = getDb()
        .prepare('SELECT id FROM conversations WHERE id = ?')
        .get(id)
      if (!conv) return reply.code(404).send({ error: 'Not found' })

      // Set SSE headers — disable all buffering
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      reply.raw.write('\n')
      reply.hijack()

      // Track client count for push notification decisions
      sseClients.set(id, (sseClients.get(id) ?? 0) + 1)

      const unsubscribe = subscribeConversation(id, (data) => {
        reply.raw.write(`data: ${data}\n\n`)
      })

      // If Claude is already running for this conversation, notify the new client
      if ((await getRunningInvocation(id)).running) {
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'thinking', thinking: true })}\n\n`,
        )
      }

      // Heartbeat to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        reply.raw.write(': heartbeat\n\n')
      }, 30000)

      req.raw.on('close', () => {
        unsubscribe()
        clearInterval(heartbeat)
        const count = (sseClients.get(id) ?? 1) - 1
        if (count <= 0) sseClients.delete(id)
        else sseClients.set(id, count)

        // Mark conversation as read up to this point
        getDb()
          .prepare(
            'UPDATE conversations SET last_read_at = unixepoch() WHERE id = ?',
          )
          .run(id)
      })
    },
  )

  // ── Send message ───────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/:id/messages',
    auth,
    async (req, reply) => {
      const { id } = req.params
      const { content, attachments, model, effort } = req.body as {
        content?: string
        attachments?: Attachment[]
        model?: string
        effort?: string
      }

      const conv = getDb()
        .prepare('SELECT * FROM conversations WHERE id = ?')
        .get(id) as ConvRow | undefined
      if (!conv) return reply.code(404).send({ error: 'Not found' })

      if (!content?.trim() && !attachments?.length) {
        return reply.code(400).send({ error: 'Empty message' })
      }

      if (await isRunning(id)) {
        return reply.code(409).send({
          error: 'Claude is already processing a message in this conversation',
        })
      }

      const userMsgId = processMessage(
        id,
        conv,
        content?.trim() || '',
        attachments || [],
        {
          model: model ?? conv.model ?? undefined,
          effort: normalizeEffort(effort ?? conv.effort),
        },
      )
      return { id: userMsgId }
    },
  )

  // ── Cancel ─────────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>('/:id/cancel', auth, async (req) => {
    await cancelConversation(req.params.id)
    return { ok: true }
  })

  // ── Audio transcribe + send ────────────────────────────────────────────────

  // Throws on failure so callers can either send an HTTP error (transcribe-only)
  // or surface it into the conversation (background transcribe + send).
  async function transcribeAudioBuffer(buffer: Buffer): Promise<string> {
    const audioBlob = new Blob([new Uint8Array(buffer)], { type: 'audio/webm' })
    let transcript = ''

    const elSecrets = getConnectorValues('elevenlabs')
    if (elSecrets?.ELEVENLABS_API_KEY) {
      try {
        const form = new FormData()
        form.append('audio', audioBlob, 'audio.webm')
        form.append('model_id', 'scribe_v1')
        const elRes = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
          method: 'POST',
          headers: { 'xi-api-key': elSecrets.ELEVENLABS_API_KEY },
          body: form,
        })
        if (elRes.ok) {
          const data = await elRes.json() as { text?: string }
          transcript = (data.text ?? '').trim()
        }
      } catch { /* fall through to Whisper */ }
    }

    if (!transcript) {
      const form = new FormData()
      form.append('audio_file', audioBlob, 'audio.webm')
      const whisperRes = await fetch(
        `${config.whisperUrl}/asr?task=transcribe&output=txt`,
        { method: 'POST', body: form },
      )
      if (!whisperRes.ok) {
        throw new TranscriptionError(`Transcription failed: ${whisperRes.status}`, 502)
      }
      transcript = (await whisperRes.text()).trim()
    }

    if (!transcript) {
      throw new TranscriptionError('No speech detected', 400)
    }

    return transcript
  }

  // Transcribe-only (no message sent). Stays synchronous: the caller is waiting
  // to drop the text into the input box.
  app.post('/audio', auth, async (req, reply) => {
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: 'No audio file' })
    const buffer = await file.toBuffer()
    try {
      const transcript = await transcribeAudioBuffer(buffer)
      return { transcript }
    } catch (err) {
      const status = err instanceof TranscriptionError ? err.status : 502
      return reply.code(status).send({ error: (err as Error).message })
    }
  })

  app.post<{ Params: { id: string } }>(
    '/:id/audio',
    auth,
    async (req, reply) => {
      const { id } = req.params

      const conv = getDb()
        .prepare('SELECT * FROM conversations WHERE id = ?')
        .get(id) as ConvRow | undefined
      if (!conv) return reply.code(404).send({ error: 'Not found' })

      if (await isRunning(id)) {
        return reply.code(409).send({
          error: 'Claude is already processing a message in this conversation',
        })
      }

      const file = await req.file()
      if (!file) return reply.code(400).send({ error: 'No audio file' })

      // Read the full upload while the client is connected. Once we hold the
      // buffer, transcription + message creation happen server-side, so the
      // client can navigate away or close the app without losing the message.
      const buffer = await file.toBuffer()

      // Light up the "working" indicator now — the user message itself only
      // lands once transcription finishes a few seconds later.
      emitConversationEvent(id, { type: 'thinking', thinking: true })

      void (async () => {
        try {
          const transcript = await transcribeAudioBuffer(buffer)
          processMessage(id, conv, transcript, [])
        } catch (err) {
          console.error('[audio] background transcription failed:', err)
          emitConversationError(
            id,
            `Audio transcription failed: ${(err as Error)?.message ?? err}`,
          )
          emitConversationEvent(id, { type: 'thinking', thinking: false })
        }
      })()

      return reply.code(202).send({ accepted: true })
    },
  )
}
