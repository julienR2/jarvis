import type { FastifyInstance } from 'fastify'
import { existsSync, rmSync } from 'fs'
import { basename, extname, join } from 'path'
import { getDb, uuid } from '../db.js'
import {
  invoke,
  streamEvents,
  cancelInvocation,
  isRunning,
  getRunningInvocation,
} from '../session-manager.js'
import { generateTitle } from '../titles.js'
import { sendPushToAll } from '../push.js'
import {
  emitConversationEvent,
  subscribeConversation,
  emitGlobalEvent,
} from '../sse.js'
import { config } from '../config.js'
import { getConnectorEnvVars } from '../connectors.js'
import type { ConvRow, MessageRow } from '../types.js'

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
  const regex = /\/(?:jarvis\/)?workspace\/uploads\/([^\s)"'\]]+)/g
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

export function processMessage(
  conversationId: string,
  conv: ConvRow,
  userContent: string,
  attachments: Attachment[],
  options?: {
    skipUserMessage?: boolean
    onDone?: (text: string) => void
    model?: string
    thinking?: boolean
  },
): string | null {
  // For auto-notify conversations, prepend notification instructions
  if (conv.notify === 'auto') {
    const notifyInstruction = [
      '[NOTIFICATION DECISION REQUIRED]',
      'After completing this task, decide whether the user should be notified.',
      'If yes, run this command:',
      `curl -s -X POST ${config.internalUrl}/internal/notify \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "X-Internal-Secret: ${config.internalSecret}" \\`,
      `  -d '{"conversation_id": "${conversationId}", "title": "<short title>", "body": "<1-2 sentence summary>"}'`,
      'If the result is not worth notifying, do NOT run the command.',
      '---',
    ].join('\n')
    userContent = notifyInstruction + '\n' + userContent
  }

  // Build prompt with attachment references for Claude
  let claudePrompt = userContent
  if (attachments.length > 0) {
    const fileRefs = attachments
      .map((a) => {
        const isImage = a.mimetype.startsWith('image/')
        return `- ${a.originalName} (${a.mimetype}): ${a.path}${isImage ? ' [use Read tool to view this image]' : ''}`
      })
      .join('\n')
    const prefix = attachments.length === 1 ? 'Attached file' : 'Attached files'
    claudePrompt = `${userContent}\n\n[${prefix}:\n${fileRefs}\n]`
  }

  // Save user message (unless skipped, e.g. for crons)
  let userMsgId: string | null = null
  if (!options?.skipUserMessage) {
    userMsgId = uuid()
    const metadata =
      attachments.length > 0 ? JSON.stringify({ attachments }) : null
    console.log(`[msg] db INSERT user message ${userMsgId}`)
    getDb()
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)',
      )
      .run(userMsgId, conversationId, 'user', userContent, metadata)

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

  // Kick off the claude invocation asynchronously. The session-manager owns
  // the process lifecycle now; we just stream its events back into an
  // event handler that persists everything to the DB.
  invoke({
    prompt: claudePrompt,
    sessionId: conv.claude_session_id,
    conversationId,
    model: options?.model,
    thinking: options?.thinking,
    envVars: getConnectorEnvVars(),
  })
    .then((invocationId) => {
      attachInvocationStream(invocationId, conversationId, conv, {
        onDone: options?.onDone,
      })
    })
    .catch((err) => {
      console.error('[msg] invoke failed:', err)
      const errorMsgId = uuid()
      getDb()
        .prepare(
          'INSERT INTO messages (id, conversation_id, role, type, content) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          errorMsgId,
          conversationId,
          'assistant',
          'error',
          `Failed to start Claude: ${err?.message ?? err}`,
        )
      const row = getDb()
        .prepare('SELECT * FROM messages WHERE id = ?')
        .get(errorMsgId) as MessageRow
      emitConversationEvent(conversationId, { type: 'message', message: row })
      emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
    })

  return userMsgId
}

// ─────────────────────────────────────────────────────────────────────────────
// attachInvocationStream — subscribe to a session-manager invocation and
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

  const onEvent = (ev: import('../session-manager.js').ClaudeEvent) => {
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
            () => {},
          )
        }

        // Auto-generate title on first exchange
        const msgCount = (
          getDb()
            .prepare(
              'SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?',
            )
            .get(conversationId) as { c: number }
        ).c

        if (msgCount <= 3 && ev.sessionId) {
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
// restart. The session-manager kept the process alive and buffered its events;
// we drop any partial assistant message that was being written before the
// restart (so the replay doesn't duplicate content) and then stream normally.
// ─────────────────────────────────────────────────────────────────────────────

export function resumeProcessMessage(
  invocationId: string,
  conversationId: string,
  conv: ConvRow,
): void {
  // Delete any partial assistant message (no result, no error type) that was
  // being streamed before the restart — the session-manager will replay all
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
      .prepare('INSERT INTO conversations (id, title) VALUES (?, ?)')
      .run(id, title ?? 'New conversation')
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
    const { title, notify } = req.body as { title?: string; notify?: string }

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

    if (sets.length === 0) {
      return reply.code(400).send({ error: 'Nothing to update' })
    }

    sets.push('updated_at = unixepoch()')
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
    // Clean up mini-app files if this conversation has one
    const conv = getDb()
      .prepare('SELECT mini_app_path FROM conversations WHERE id = ?')
      .get(req.params.id) as ConvRow | undefined
    if (conv?.mini_app_path) {
      const appDir = join(config.workspaceDir, 'mini-apps', req.params.id)
      if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true })
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
      const { content, attachments, model, thinking } = req.body as {
        content?: string
        attachments?: Attachment[]
        model?: string
        thinking?: boolean
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
        { model, thinking },
      )
      return { id: userMsgId }
    },
  )

  // ── Cancel ─────────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>('/:id/cancel', auth, async (req) => {
    const { id } = req.params
    cancelledConversations.add(id)
    const status = await getRunningInvocation(id)
    if (status.running) {
      await cancelInvocation(status.invocationId)
    }
    emitConversationEvent(id, { type: 'thinking', thinking: false })
    return { ok: true }
  })

  // ── Audio transcribe + send ────────────────────────────────────────────────

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

      // Read the file buffer
      const buffer = await file.toBuffer()

      // Send to Whisper for transcription
      const form = new FormData()
      form.append(
        'audio_file',
        new Blob([new Uint8Array(buffer)]),
        'audio.webm',
      )

      const whisperRes = await fetch(
        `${config.whisperUrl}/asr?task=transcribe&output=txt`,
        {
          method: 'POST',
          body: form,
        },
      )

      if (!whisperRes.ok) {
        return reply
          .code(502)
          .send({ error: `Transcription failed: ${whisperRes.status}` })
      }

      const transcript = (await whisperRes.text()).trim()
      if (!transcript) {
        return reply.code(400).send({ error: 'No speech detected' })
      }

      // Process as a regular message
      const userMsgId = processMessage(id, conv, transcript, [])
      return { id: userMsgId, transcript }
    },
  )
}
