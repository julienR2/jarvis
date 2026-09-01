import type { FastifyInstance } from 'fastify'
import { existsSync } from 'fs'
import { basename, extname, resolve, sep } from 'path'
import { getDb, uuid, normalizeEffort } from '../db.js'
import { archiveAppDir } from '../app-archive.js'
import { ensureAppToken, rotateAppToken } from '../app-tokens.js'
import { UPLOADS_DIR } from './uploads.js'
import {
  sendMessage,
  streamConversation,
  interruptConversation,
  isRunning,
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

    // The captured group is the path *relative to* uploads/, which may now be
    // nested (`<conversationId>/file.png`). It has to survive into the url or
    // the static handler 404s — but it comes out of model-written text, so
    // reject anything that climbs back out of the uploads tree.
    const relPath = match[1]
    const resolved = resolve(UPLOADS_DIR, relPath)
    if (resolved !== UPLOADS_DIR && !resolved.startsWith(UPLOADS_DIR + sep)) continue

    const name = basename(fullPath)
    const ext = extname(name).toLowerCase()
    const mimetype = MIME_TYPES[ext] || 'application/octet-stream'
    attachments.push({
      id: uuid(),
      filename: relPath,
      originalName: name,
      mimetype,
      url: `/api/uploads/files/${relPath}`,
      path: fullPath,
    })
  }

  return attachments
}

// ── Message pagination ───────────────────────────────────────────────────────
// Long conversations (mail triage, crons) grow to thousands of messages, which
// is too much DOM for the client to render at once. Reads are paginated
// newest-first; the client walks backwards as the user scrolls up.

const MESSAGE_PAGE_SIZE = 100
// Ceiling on `limit`. A client that has paged back further than this and then
// re-syncs gets trimmed to the newest 1000 and has to scroll again — the only
// cost of not tracking gaps client-side.
const MAX_MESSAGE_PAGE_SIZE = 1000

/** Read a message back with its cursor, for SSE payloads. */
function getMessageRow(id: string): MessageRow {
  return getDb()
    .prepare('SELECT m.*, m.rowid AS seq FROM messages m WHERE m.id = ?')
    .get(id) as MessageRow
}

/**
 * The `limit` newest messages, returned oldest-first so the client can render
 * (and prepend) them without re-sorting. `before` is the `seq` of the oldest
 * message the client already holds.
 *
 * Ordering keys on created_at then rowid: created_at only has second
 * resolution, so it can't order a burst of messages on its own, while rowid is
 * strict insertion order — which is why it, not created_at, is the cursor.
 */
function fetchMessagePage(
  conversationId: string,
  limit: number,
  before?: number,
): { messages: MessageRow[]; has_more: boolean } {
  // One row past the limit tells us whether an older page exists, no COUNT(*).
  const rows = getDb()
    .prepare(
      `SELECT m.*, m.rowid AS seq FROM messages m
        WHERE m.conversation_id = ?${before ? ' AND m.rowid < ?' : ''}
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT ?`,
    )
    .all(
      ...(before
        ? [conversationId, before, limit + 1]
        : [conversationId, limit + 1]),
    ) as MessageRow[]

  const has_more = rows.length > limit
  if (has_more) rows.pop()
  return { messages: rows.reverse(), has_more }
}

function parsePageLimit(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return MESSAGE_PAGE_SIZE
  return Math.min(Math.floor(n), MAX_MESSAGE_PAGE_SIZE)
}

// Track SSE clients per conversation for push notification decisions
const sseClients = new Map<string, number>()

// Track cancelled conversations to suppress error messages from SIGTERM
const cancelledConversations = new Set<string>()

export async function cancelConversation(conversationId: string): Promise<void> {
  cancelledConversations.add(conversationId)
  // Soft interrupt: the engine stops the in-flight turn via the CLI control
  // protocol but keeps the session (and its warm context) alive.
  await interruptConversation(conversationId)
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
  emitConversationEvent(conversationId, {
    type: 'message',
    message: getMessageRow(errorMsgId),
  })
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

    const userRow = getMessageRow(userMsgId)
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

  // Feed the message into the conversation's persistent session. If a turn is
  // already running the CLI steers/queues it — never refused. The engine owns
  // the process lifecycle; we just stream its events back into an event
  // handler that persists everything to the DB.
  sendMessage({
    prompt: claudePrompt,
    sessionId: conv.claude_session_id,
    conversationId,
    model: resolveModel(options?.model),
    effort: options?.effort,
  })
    .then(({ queued }) => {
      attachConversationStream(conversationId, conv, {
        onDone: options?.onDone,
      })
      if (queued) {
        console.log(`[msg] steered into the running turn of ${conversationId}`)
        // The user row is already in the DB, sitting between the assistant
        // message in progress and whatever comes next. Ask the stream to stop
        // growing that message so the rest of the turn lands in a new one
        // *after* the user bubble — otherwise the reply keeps appending above
        // it and the message reads as if it were never taken into account.
        // Attach first: it creates the entry this flag lives on.
        markSteerPending(conversationId)
      }
    })
    .catch((err) => {
      console.error('[msg] sendMessage failed:', err)
      emitConversationError(
        conversationId,
        `Failed to start Claude: ${err?.message ?? err}`,
      )
      emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
    })

  return userMsgId
}

// ─────────────────────────────────────────────────────────────────────────────
// attachConversationStream — subscribe to a conversation's engine stream and
// persist its events into the DB + SSE. The stream spans turns (steered
// messages, queued messages, subagent wake-ups all flow through the same
// subscription), so exactly ONE attachment may exist per conversation — later
// callers only enqueue their onDone callback. The attachment drops when the
// engine ends the stream (session closed), and the next message re-creates it.
// ─────────────────────────────────────────────────────────────────────────────

const attachedConversations = new Map<
  string,
  {
    onDoneQueue: Array<(text: string) => void>
    // A message was steered into the running turn: close the assistant message
    // in progress at the next event so the reply resumes in a new one below the
    // user bubble. Set by markSteerPending(), consumed in appendLine().
    steerPending: boolean
  }
>()

// Answer text streamed for the turn in progress, per conversation — the same
// text the `delta` events carry, kept only so a client that connects mid-answer
// can be handed what it missed. Deltas are live-only and never replayed, so
// without this a browser opening a conversation mid-reply sees an empty gap
// until the block closes. Dropped the moment the text is persisted.
const liveTurnText = new Map<string, string>()

/**
 * Mark that a mid-turn message was steered into `conversationId`, so the
 * assistant message in progress gets closed before the next event is appended.
 *
 * The CLI gives no signal for the moment it actually reads a steered message
 * (it splices the text into its next API request without emitting it on
 * stdout), so arrival is the only handle we have. The next event is a close
 * proxy: the CLI can only pick the message up at a request boundary, which is
 * where the following event comes from. It can land a beat early when more
 * pre-steering work was already queued — good enough, and far better than the
 * reply growing above the user bubble for the rest of the turn.
 */
function markSteerPending(conversationId: string): void {
  const attached = attachedConversations.get(conversationId)
  if (attached) attached.steerPending = true
}

export function attachConversationStream(
  conversationId: string,
  conv: ConvRow,
  options?: { onDone?: (text: string) => void },
): void {
  const existing = attachedConversations.get(conversationId)
  if (existing) {
    if (options?.onDone) existing.onDoneQueue.push(options.onDone)
    return
  }
  const attached = {
    onDoneQueue: options?.onDone ? [options.onDone] : [],
    steerPending: false,
  }
  attachedConversations.set(conversationId, attached)

  // Per-turn assembly state — one assistant message, progressively updated,
  // reset at every done/error so the next turn starts a fresh message.
  let msgId: string | null = null
  let lines: string[] = []

  // ── Live-stream coalescing ─────────────────────────────────────────────────
  // Measured: the CLI already batches its own partial messages — a 241-char
  // answer arrived as 8 deltas, front-loaded token-sized then jumping to 85- and
  // 124-char blocks. So there is no token firehose to defend against here, and
  // the original 60ms window was actively harmful: it re-batched already-batched
  // text into a handful of visible jumps.
  //
  // This is now just a flood guard for a model that streams genuinely per-token,
  // set to roughly one animation frame so it adds no perceptible latency.
  // Smoothness is the client's job — see the typewriter in LiveTurn.
  const LIVE_FLUSH_MS = 16
  let deltaBuf = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flushLive(): void {
    flushTimer = null
    if (deltaBuf) {
      emitConversationEvent(conversationId, { type: 'delta', text: deltaBuf })
      liveTurnText.set(
        conversationId,
        (liveTurnText.get(conversationId) ?? '') + deltaBuf,
      )
      deltaBuf = ''
    }
  }

  function scheduleLive(): void {
    if (!flushTimer) flushTimer = setTimeout(flushLive, LIVE_FLUSH_MS)
  }

  /**
   * Discard anything buffered, without sending it.
   *
   * Called wherever a persisted message is about to supersede the live buffer.
   * Dropping rather than flushing is deliberate: the authoritative message is
   * being emitted right now and the client replaces its streaming buffer with
   * it, so a delta landing *after* that would re-show text the real message
   * already contains.
   *
   * Belt-and-braces, not the only guard: the client clears its live buffer on
   * *any* assistant message event, which is what covers the paths that don't
   * call this — notably a `note` closing a block whose deltas already went out.
   */
  function dropLive(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    deltaBuf = ''
    liveTurnText.delete(conversationId)
  }

  /**
   * Append one activity line to the assistant message in progress.
   *
   * `group` identifies the assistant message the event came from and is written
   * into the marker as `[prefix:group]`. It is what lets the UI tell a note that
   * labels the tools under it from one that merely precedes them — see
   * ActivityGroup in the engine's shared.ts. Omitted when the engine didn't send
   * one (legacy one-shot stack), which reads back as an unknown group rather
   * than as group 0.
   */
  function appendLine(prefix: string, text: string, group?: number) {
    // A steered message was inserted since the last event. Close the message in
    // progress so this line starts a new one, which — being inserted later —
    // sorts after the user bubble (ordering is rowid, see fetchMessagePage).
    // Nothing to split when no message is open yet: the steer arrived before
    // any output, so appending here already lands below the user bubble.
    if (attached.steerPending) {
      attached.steerPending = false
      if (msgId) {
        console.log(`[msg] steer split: closing assistant ${msgId}`)
        msgId = null
        lines = []
      }
    }

    const marker = group === undefined ? prefix : `${prefix}:${group}`
    lines.push(`[${marker}] ${text}`)
    const content = lines.join('\n\n')

    if (!msgId) {
      msgId = uuid()
      console.log(
        `[msg] db INSERT assistant ${msgId}: [${marker}] ${text.slice(0, 80)}`,
      )
      getDb()
        .prepare(
          'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
        )
        .run(msgId, conversationId, 'assistant', content)
      // A new turn began. For turns the CLI starts on its own (background
      // subagent wake-ups) no processMessage ran, so signal thinking here —
      // it's idempotent for turns that did go through processMessage.
      emitConversationEvent(conversationId, { type: 'thinking', thinking: true })
    } else {
      console.log(
        `[msg] db UPDATE assistant ${msgId}: +[${marker}] ${text.slice(0, 80)}`,
      )
      getDb()
        .prepare('UPDATE messages SET content = ? WHERE id = ?')
        .run(content, msgId)
    }

    const row = getMessageRow(msgId)
    console.log(`[msg] emit message ${msgId}: ${lines.length} lines`)
    emitConversationEvent(conversationId, { type: 'message', message: row })
  }

  const onEvent = (ev: import('../engine.js').ClaudeEvent) => {
      // Live-only event: straight to SSE, never near the DB. Returning early
      // keeps it out of appendLine, whose whole-row rewrite per event is fine
      // for the handful of tool/chunk events in a turn and quadratic for tokens.
      if (ev.type === 'delta') {
        deltaBuf += ev.text
        scheduleLive()
        return
      }

      if (ev.type === 'tool') {
        appendLine('tool', ev.name, ev.group)
      }

      if (ev.type === 'note') {
        appendLine('note', ev.text, ev.group)
      }

      if (ev.type === 'chunk') {
        // The block just closed and its full text is about to be persisted and
        // pushed — whatever deltas are still buffered for it are now redundant.
        dropLive()
        appendLine('chunk', ev.text.trim(), ev.group)
      }

      if (ev.type === 'usage') {
        // The window is stored as sent, nulls included. Carrying the previous
        // value over would be wrong, not merely stale: the engine only reports
        // null for a model it doesn't recognise, and what we hold was learned
        // for whatever model ran BEFORE — so keeping it measures the new model
        // against the old one's denominator. A recognised model always reports
        // a number, so nothing is lost by dropping it.
        // Deliberately not touching updated_at — a token count isn't activity
        // and would reshuffle the sidebar on every assistant message.
        getDb()
          .prepare(
            `UPDATE conversations
                SET context_tokens = ?,
                    context_window = ?
              WHERE id = ?`,
          )
          .run(ev.contextTokens, ev.contextWindow, conversationId)
        emitConversationEvent(conversationId, {
          type: 'usage',
          contextTokens: ev.contextTokens,
          contextWindow: ev.contextWindow,
        })
      }

      if (ev.type === 'done') {
        dropLive()
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

        const row = getMessageRow(msgId)
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

        // Only drop the thinking indicator when the conversation is actually
        // finished. A turn that ends with background subagents still running
        // (ev.pending) will be followed by a wake-up turn — flickering the
        // spinner off in between reads as "done" while work continues.
        if (ev.pending) {
          console.log(`[msg] turn done but background tasks pending — keeping thinking on`)
        } else {
          console.log(`[msg] emit thinking: false`)
          emitConversationEvent(conversationId, {
            type: 'thinking',
            thinking: false,
          })
        }
        // A soft interrupt resolves as a normal done — clear the suppression
        // flag so it doesn't swallow a genuine error later in the session.
        cancelledConversations.delete(conversationId)
        for (const cb of attached.onDoneQueue.splice(0)) cb(resultText)
        // Reset the per-turn state: the stream stays attached and the next
        // turn (steered, queued or wake-up) starts a fresh assistant message.
        // That new message covers a steer this turn never got to — clearing the
        // flag keeps it from splitting the next turn's first line instead.
        msgId = null
        lines = []
        attached.steerPending = false

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
        dropLive()
        console.log(`[msg] error: ${ev.message.slice(0, 120)}`)
        // Close out the turn either way — a new one may follow on this stream.
        msgId = null
        lines = []

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

        const errorRow = getMessageRow(errorMsgId)
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

  streamConversation(conversationId, onEvent, () => {
    // Stream ended server-side (session closed / legacy turn finished) —
    // drop the guard so the next message re-attaches. If a pending done kept
    // the spinner on and the session died before its wake-up turn, this is
    // the safety net that turns it off.
    dropLive()
    attachedConversations.delete(conversationId)
    emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// resumeProcessMessage — re-attach to a busy conversation after a backend
// restart. The engine kept the process alive and buffered the current turn's
// events; we drop any partial assistant message that was being written before
// the restart (so the replay doesn't duplicate content) and then stream
// normally.
// ─────────────────────────────────────────────────────────────────────────────

export function resumeProcessMessage(
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

  attachConversationStream(conversationId, conv)
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

  // Returns the conversation with its most recent page of messages. `limit`
  // lets a reconnecting client ask for everything it had already loaded, so
  // catching up doesn't throw away the pages it scrolled back through.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/:id',
    auth,
    async (req, reply) => {
      // unread_count is read *before* the last_read_at reset below — it is what
      // the client needs to place the "unread messages" divider, and after the
      // reset it is always 0. Opening a conversation cold (a notification tap
      // lands straight on /c/:id) races the list request, so the list's own
      // count can't be relied on either.
      const conv = getDb()
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
         FROM conversations c WHERE c.id = ?`,
        )
        .get(req.params.id)
      if (!conv) return reply.code(404).send({ error: 'Not found' })

      getDb()
        .prepare(
          'UPDATE conversations SET last_read_at = unixepoch() WHERE id = ?',
        )
        .run(req.params.id)

      const page = fetchMessagePage(req.params.id, parsePageLimit(req.query.limit))
      return { ...(conv as object), ...page }
    },
  )

  // Older messages, walking backwards from the `before` cursor (a message `seq`).
  app.get<{
    Params: { id: string }
    Querystring: { before?: string; limit?: string }
  }>('/:id/messages', auth, async (req, reply) => {
    const exists = getDb()
      .prepare('SELECT 1 FROM conversations WHERE id = ?')
      .get(req.params.id)
    if (!exists) return reply.code(404).send({ error: 'Not found' })

    const before = Number(req.query.before)
    return fetchMessagePage(
      req.params.id,
      parsePageLimit(req.query.limit),
      Number.isFinite(before) && before > 0 ? before : undefined,
    )
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

  // ── App share link ─────────────────────────────────────────────────────────

  // GET /:id/app-token — the conversation's share token, minted on first ask.
  app.get<{ Params: { id: string } }>('/:id/app-token', auth, async (req, reply) => {
    const token = ensureAppToken(req.params.id)
    if (!token) return reply.code(404).send({ error: 'Not found' })
    return { token }
  })

  // POST /:id/app-token/rotate — invalidate every link already handed out.
  app.post<{ Params: { id: string } }>(
    '/:id/app-token/rotate',
    auth,
    async (req, reply) => {
      const token = rotateAppToken(req.params.id)
      if (!token) return reply.code(404).send({ error: 'Not found' })
      return { token }
    },
  )

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

      // ── Seed the state of the turn in progress ───────────────────────────
      // A turn that started before this connection existed left two things the
      // event stream itself won't repeat: the answer text streamed so far, and
      // the fact that it is still running.

      // Read AND written before subscribing: a delta landing in between is then
      // merely lost (the `chunk` that closes the block restores it), whereas
      // seeding after subscribing would re-show text the client just appended.
      const liveSeed = liveTurnText.get(id)
      if (liveSeed) {
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'delta', text: liveSeed })}\n\n`,
        )
      }

      // Any thinking event forwarded during the isRunning round-trip is more
      // current than its answer, so it wins — the seed is skipped rather than
      // allowed to overwrite it with a stale value.
      let sawThinking = false
      const unsubscribe = subscribeConversation(id, (data) => {
        if (data.includes('"type":"thinking"')) sawThinking = true
        reply.raw.write(`data: ${data}\n\n`)
      })

      // Sent whether or not a turn is running: `false` matters just as much, as
      // nothing else tells a reconnecting client that the turn it last saw
      // running has since finished — which used to leave its spinner on for good.
      const running = await isRunning(id)
      if (!sawThinking) {
        reply.raw.write(
          `data: ${JSON.stringify({ type: 'thinking', thinking: running })}\n\n`,
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

        // Mark the conversation read up to this point.
        //
        // Not simply `unixepoch()`, because an assistant row is INSERTed on the
        // turn's *first* line and UPDATEd until the turn ends: its created_at is
        // when the answer started, not when it landed. Stamping now while a turn
        // is in flight sorts *after* a message that isn't written yet, so the
        // unread query (created_at > last_read_at) silently drops it — walking
        // away while Jarvis is still answering cost you the badge for that whole
        // reply.
        //
        // So when a turn is running, park the mark just below the row being
        // written: earlier turns the user did watch stay read, and the in-flight
        // one surfaces as unread once it lands.
        isRunning(id).then((running) => {
          if (!running) {
            getDb()
              .prepare(
                'UPDATE conversations SET last_read_at = unixepoch() WHERE id = ?',
              )
              .run(id)
            return
          }
          // COALESCE: the turn may not have written its first line yet, in which
          // case there is no row to park below and the mark stays put.
          getDb()
            .prepare(
              `UPDATE conversations SET last_read_at = COALESCE(
                 (SELECT m.created_at - 1 FROM messages m
                   WHERE m.conversation_id = ?
                     AND m.role = 'assistant'
                     AND m.type IS NULL
                   ORDER BY m.rowid DESC LIMIT 1),
                 last_read_at
               ) WHERE id = ?`,
            )
            .run(id, id)
        })
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

      // No busy check: a message sent while Claude works is steered into the
      // running turn (or queued) by the CLI — that's a feature now.
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
