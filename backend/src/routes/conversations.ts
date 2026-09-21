import type { FastifyInstance } from 'fastify'
import { verifySession } from '../request-auth.js'
import { existsSync } from 'fs'
import { basename, extname, resolve, sep } from 'path'
import { getDb, uuid, normalizeEffort } from '../db.js'
import { activeRuns, finishRun, runStatus, stopRunsFor } from '../runs.js'
import { ownerOrShare, resolveShareToken } from '../share-access.js'
import { archiveAppDir, archiveUploadsDir, purgeConversationFiles } from '../app-archive.js'
import { rescheduleAll } from '../crons.js'
import { ensureAppToken, rotateAppToken, generateShareToken } from '../app-tokens.js'
import { UPLOADS_DIR } from './uploads.js'
import {
  sendMessage,
  streamConversation,
  interruptConversation,
  isRunning,
  answerPrompt,
} from '../engine.js'
import {
  getPendingQuestion,
  setPendingQuestion,
  dropPendingQuestion,
  describePending,
  questionsOf,
} from '../questions.js'
import { generateTitle, mediaTitle, UNTITLED } from '../titles.js'
import { resolveModel } from '../models.js'
import { modelKind } from '../catalogue.js'
import { generateMedia } from '../media.js'
import { sendPushToAll } from '../push.js'
import {
  emitConversationEvent,
  subscribeConversation,
  emitGlobalEvent,
} from '../sse.js'
import { config } from '../config.js'
import { getConnectorValues } from '../connectors.js'
import { topicContextFor } from '../topics.js'
import type { ConvRow, MessageRow, EffortLevel, PendingQuestion } from '../types.js'
import { userForApiKey } from '../api-keys.js'

export interface Attachment {
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
export function fetchMessagePage(
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

export function parsePageLimit(raw: string | undefined): number {
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
  // …and the background runs, which the line above cannot reach. An isolated
  // run lives under its own engine key, so cancelling the conversation used to
  // interrupt a session the run was never in: the button reported success and
  // the cron kept going. Stop means stop everything happening in this chat.
  await stopRunsFor(conversationId)
  emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
}

/** Transcription failure carrying the HTTP status to use when reported inline. */
class TranscriptionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** Insert an assistant-side error message and push it to any connected clients. */
/**
 * The block that tells Claude where attached files landed, appended to the
 * text it goes with. Shared by a normal message and an answer to a question.
 */
function attachmentRefs(attachments: Attachment[]): string {
  if (attachments.length === 0) return ''
  const fileRefs = attachments
    .map((a) => {
      const isImage = a.mimetype.startsWith('image/')
      return `- ${a.originalName} (${a.mimetype}): ${a.path}${isImage ? ' [use Read tool to view this image]' : ''}`
    })
    .join('\n')
  const prefix = attachments.length === 1 ? 'Attached file' : 'Attached files'
  return `\n\n[${prefix}:\n${fileRefs}\n]`
}

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

/** A passage of an earlier message the person is replying to. */
export interface ReplyTo {
  message_id: string
  text: string
}

export function processMessage(
  conversationId: string,
  conv: ConvRow,
  userContent: string,
  attachments: Attachment[],
  options?: {
    skipUserMessage?: boolean
    userMessageOverride?: string
    // The quoted passage goes to Claude in its own article ahead of the text,
    // and is stored on the message's metadata for the bubble to show.
    replyTo?: ReplyTo
    onDone?: (text: string) => void
    model?: string
    effort?: EffortLevel
    // A routine's own reasoning setting; the conversation's applies otherwise.
    reasoning?: boolean
    // Run under a throwaway engine session instead of the conversation's own.
    // The messages still persist and stream into `conversationId`; what the run
    // does NOT get is the conversation's history, and what the conversation does
    // NOT get is this run's session. Used by crons and webhooks whose prompt is
    // self-contained (see inherit_context).
    runKey?: string
    // The `runs` row this turn belongs to. Stamped onto every message the turn
    // writes, so the chat can say where a message came from and whether it saw
    // the conversation's history — and so a failure closes the run out.
    runId?: string
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

  // The topic's brief, when this chat is filed under one and its session has
  // not seen the current text yet. Ephemeral like the notify block: the saved
  // message is what the person typed, not what the model was told around it.
  if (!isCommand) {
    const brief = topicContextFor(conv, { freshSession: !!options?.runKey })
    if (brief) claudePrompt = brief + '\n' + claudePrompt
  }

  // Append attachment references for Claude
  if (attachments.length > 0 && !isCommand) {
    claudePrompt = `${claudePrompt}${attachmentRefs(attachments)}`
  }

  // The passage being replied to, delimited like the other prompt articles so
  // the model knows it is a quote of its own (or the person's) earlier words
  // and not new text to act on. The saved message stays the person's text.
  const replyTo = options?.replyTo
  if (replyTo && !isCommand) {
    const quote = [
      `<article data-jarvis="reply-to" message="${replyTo.message_id}">`,
      'The user is replying to this passage of an earlier message in the conversation:',
      replyTo.text,
      '</article>',
    ].join('\n')
    claudePrompt = `${quote}\n${claudePrompt}`
  }

  // Save user message (unless skipped, e.g. for crons)
  let userMsgId: string | null = null
  if (!options?.skipUserMessage) {
    userMsgId = uuid()
    const meta: Record<string, unknown> = {}
    if (attachments.length > 0) meta.attachments = attachments
    if (replyTo) meta.reply_to = replyTo
    const metadata = Object.keys(meta).length ? JSON.stringify(meta) : null
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

  // A media model isn't an agent: the message is a prompt for a picture or a
  // clip, so it goes straight to the gateway's media endpoint instead of the
  // CLI. Choosing an image model chooses the pipeline.
  const chosenModel = resolveModel(options?.model)
  modelKind(chosenModel)
    .then((kind) => {
      if (kind === 'text') return dispatchToAgent()
      return runMediaGeneration(conversationId, chosenModel, kind, userContent, options?.onDone)
    })
    // An unhandled rejection here takes the whole backend down with it, and
    // this branch runs detached from the request that started it.
    .catch((err) => {
      console.error('[msg] dispatch failed:', err)
      emitConversationError(conversationId, err?.message ?? String(err))
    })

  return userMsgId

  function dispatchToAgent() {
  // Feed the message into the conversation's persistent session. If a turn is
  // already running the CLI steers/queues it — never refused. The engine owns
  // the process lifecycle; we just stream its events back into an event
  // handler that persists everything to the DB.
  // An isolated run talks to the engine under its own key and starts with no
  // session to resume, which is what makes it cheap: a fresh spawn carries the
  // system prompt and skills only, not the conversation's accumulated history.
  const runKey = options?.runKey
  const isolated = !!runKey

  sendMessage({
    prompt: claudePrompt,
    sessionId: isolated ? null : conv.claude_session_id,
    conversationId: runKey ?? conversationId,
    model: resolveModel(options?.model),
    effort: options?.effort,
    reasoning: options?.reasoning ?? !!conv.thinking,
    // The engine derives JARVIS_CONVERSATION_ID from the session key, which for
    // an isolated run is the throwaway runKey. Point it back at the real
    // conversation: skills write uploads and apps under that id and read the
    // conversation back through it, and none of that resolves for `cron-…`.
    envVars: isolated ? { JARVIS_CONVERSATION_ID: conversationId } : undefined,
    // The run is a single turn under a key nothing else will ever address, so
    // the session has no second use: close it at the result rather than let it
    // sit idle for the reaper's 15 minutes. Sessions are capped (8), and a
    // handful of schedules firing together would otherwise spend that window
    // evicting the conversations someone is actually talking to.
    oneShot: isolated,
  })
    .then(({ queued }) => {
      attachConversationStream(conversationId, conv, {
        onDone: options?.onDone,
        runKey,
        isolated,
        runId: options?.runId,
      })
      if (queued) {
        console.log(`[msg] steered into the running turn of ${conversationId}`)
        // The user row is already in the DB, sitting between the assistant
        // message in progress and whatever comes next. Ask the stream to stop
        // growing that message so the rest of the turn lands in a new one
        // *after* the user bubble — otherwise the reply keeps appending above
        // it and the message reads as if it were never taken into account.
        // Attach first: it creates the entry this flag lives on.
        markSteerPending(runKey ?? conversationId)
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
  }
}

/** Store a generated title and tell open screens, only while the placeholder is still there. */
function applyTitle(conversationId: string, title: string): void {
  const r = getDb()
    .prepare('UPDATE conversations SET title = ? WHERE id = ? AND title = ?')
    .run(title, conversationId, UNTITLED)
  if (r.changes === 0) return
  emitConversationEvent(conversationId, { type: 'conversation', id: conversationId, title })
}

/**
 * Run a media model and land the result as an assistant message.
 *
 * Written as an attachment rather than markdown so it renders through the same
 * path an uploaded file does — the UI already knows how to show those, and the
 * bytes are served with the same per-conversation access rules.
 */
async function runMediaGeneration(
  conversationId: string,
  model: string,
  kind: 'image' | 'video' | 'audio',
  prompt: string,
  onDone?: (text: string) => void,
): Promise<void> {
  try {
    const stillThere = getDb()
      .prepare('SELECT 1 FROM conversations WHERE id = ?')
      .get(conversationId)
    if (!stillThere) return

    const media = await generateMedia({
      kind,
      conversationId,
      model,
      prompt,
      onProgress: (note) =>
        emitConversationEvent(conversationId, { type: 'note', text: note } as never),
    })

    const id = uuid()
    const text = `Generated with \`${model}\`.`
    getDb()
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, content, result, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        conversationId,
        'assistant',
        text,
        text,
        JSON.stringify({ attachments: [media] }),
      )
    emitConversationEvent(conversationId, {
      type: 'message',
      message: getMessageRow(id),
    })
    // No session to ask for a title here; the prompt is the subject.
    const row = getDb()
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversationId) as { title: string } | undefined
    if (row?.title === UNTITLED) {
      const title = mediaTitle(prompt)
      if (title) applyTitle(conversationId, title)
    }
    onDone?.(text)
  } catch (err: any) {
    // Reporting a failure must not itself fail. A conversation deleted while
    // its generation was still running leaves nothing to attach an error to,
    // and the foreign key violation used to escape as an unhandled rejection
    // and stop the server.
    try {
      emitConversationError(conversationId, err?.message ?? String(err))
    } catch (reportErr) {
      console.error('[media] could not report failure:', reportErr)
    }
  } finally {
    try {
      emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
      getDb()
        .prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?')
        .run(conversationId)
    } catch {
      /* conversation is gone; nothing left to update */
    }
  }
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
    // The `runs` rows this stream is serving. Usually zero (a human turn) or
    // one; more when several inherited runs were steered into the same turn.
    runIds: Set<string>
    // Prompts the engine raised that are not yet the conversation's pending
    // question — the model asked several things in one message. Shown one at
    // a time, in order, as each is answered.
    askQueue: PendingQuestion[]
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
  options?: {
    onDone?: (text: string) => void
    runKey?: string
    isolated?: boolean
    runId?: string
  },
): void {
  // `conversationId` names two things that are usually the same and, for an
  // isolated run, deliberately are not:
  //
  //   streamKey      — which engine session we subscribe to and assemble from
  //   conversationId — where the resulting messages are persisted and shown
  //
  // A cron firing with inherit_context = 0 runs under a throwaway streamKey, so
  // it gets a clean session, while its output still lands in the conversation
  // it is linked to. Everything below that touches the DB or the UI keeps using
  // conversationId; only the engine-facing bookkeeping uses streamKey.
  const streamKey = options?.runKey ?? conversationId
  const isolated = options?.isolated ?? false

  const existing = attachedConversations.get(streamKey)
  if (existing) {
    if (options?.onDone) existing.onDoneQueue.push(options.onDone)
    // A run that inherits context reuses the conversation's existing stream, so
    // there is no second attachment to carry its id — it joins this one. The
    // set, not a single field: several inherited runs can be steered into the
    // same turn, and all of them end when it does.
    if (options?.runId) existing.runIds.add(options.runId)
    return
  }
  const attached = {
    onDoneQueue: options?.onDone ? [options.onDone] : [],
    steerPending: false,
    runIds: new Set<string>(options?.runId ? [options.runId] : []),
    askQueue: [] as PendingQuestion[],
  }
  attachedConversations.set(streamKey, attached)

  // Written into every message this stream produces, so the chat can attribute
  // it and mark whether it ran outside the conversation's memory. Read fresh
  // from `attached.runIds` at write time rather than captured: an inherited run
  // can join after the stream was created.
  const runMetadata = (): string | null => {
    const ids = [...attached.runIds]
    if (ids.length === 0) return null
    // Newest wins when several runs share a turn: it is the one whose prompt
    // produced the text being written.
    return JSON.stringify({ run_id: ids[ids.length - 1], isolated })
  }

  /**
   * Close out the runs this stream is serving.
   *
   * Run status is owned here rather than in the cron/webhook onDone callback,
   * because only this handler knows about `pending` — a turn that ends with
   * background subagents still working is followed by a wake-up turn, and
   * marking the run finished there would drop the Stop button while it is
   * still, in every sense that matters, running.
   */
  const closeRuns = (
    status: 'done' | 'error' | 'interrupted',
    detail?: { result?: string; error?: string },
  ) => {
    for (const id of attached.runIds) finishRun(id, status, detail)
    attached.runIds.clear()
  }

  /**
   * A turn ended one way or another: nothing it was waiting on can be answered
   * any more. Clears the card (and the queue behind it) if this stream owned it.
   */
  const closeQuestions = () => {
    attached.askQueue.length = 0
    const current = getPendingQuestion(conversationId)
    if (current && current.session_key === streamKey) setPendingQuestion(conversationId, null)
  }

  /** Make `q` the conversation's pending question and say so everywhere. */
  const raiseQuestion = (q: PendingQuestion) => {
    setPendingQuestion(conversationId, q)
    const summary = describePending(q)
    // The pause is part of the record: the transcript keeps a line saying what
    // was asked, and the answer lands under it as the person's message.
    appendLine('note', `Waiting for you: ${summary}`)
    // A question with nobody looking is the one case where a push is always
    // worth it — short of the person having asked never to be told.
    if (conv.notify !== 'unsubscribe') {
      sendPushToAll(`${conv.title} · needs you`, summary.slice(0, 200), `/c/${conversationId}`).catch(
        (err) => console.error('[push] sendPushToAll failed:', err),
      )
    }
  }

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
          'INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)',
        )
        .run(msgId, conversationId, 'assistant', content, runMetadata())
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
        // Isolated runs don't stream live text. `liveTurnText` is keyed by
        // conversation, and two background runs reporting into the same one
        // would interleave character-for-character into a single buffer with
        // no way to tell them apart. Their progress is still visible — the
        // tool/note/chunk lines are persisted messages, each stamped with its
        // run id — so what's given up is per-token typing on work nobody is
        // watching being typed.
        if (isolated) return
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

      if (ev.type === 'ask') {
        const ids = [...attached.runIds]
        const q: PendingQuestion = {
          request_id: ev.requestId,
          tool_name: ev.toolName,
          tool_use_id: ev.toolUseId,
          input: ev.input,
          session_key: streamKey,
          run_id: ids.length ? ids[ids.length - 1] : null,
          asked_at: Math.floor(Date.now() / 1000),
        }
        const current = getPendingQuestion(conversationId)
        if (current && current.request_id === q.request_id) {
          // Replayed after a re-attach: already on record.
        } else if (current && current.session_key === streamKey) {
          console.log(`[msg] a question is already open — queueing ${q.tool_name} (${q.request_id})`)
          attached.askQueue.push(q)
        } else {
          console.log(`[msg] waiting for you: ${q.tool_name} (${q.request_id})`)
          raiseQuestion(q)
        }
      }

      if (ev.type === 'ask_done') {
        attached.askQueue = attached.askQueue.filter((q) => q.request_id !== ev.requestId)
        const current = getPendingQuestion(conversationId)
        if (current && current.request_id === ev.requestId) {
          const next = attached.askQueue.shift()
          if (next) raiseQuestion(next)
          else setPendingQuestion(conversationId, null)
          // The answer itself was written to the transcript by answerQuestion,
          // which is the only path that resolves a prompt as `answered`.
          if (ev.outcome === 'withdrawn') appendLine('note', 'The question was withdrawn.')
        }
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
              'INSERT INTO messages (id, conversation_id, role, content, result, metadata) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(msgId, conversationId, 'assistant', '', resultText, runMetadata())
        } else {
          console.log(`[msg] db UPDATE assistant ${msgId}: set result`)
          getDb()
            .prepare('UPDATE messages SET result = ? WHERE id = ?')
            .run(resultText, msgId)
        }

        const row = getMessageRow(msgId)
        console.log(`[msg] emit message (done) ${msgId}`)
        emitConversationEvent(conversationId, { type: 'message', message: row })

        // Update session ID if new.
        //
        // Skipped for an isolated run: that session is a throwaway created for
        // this fire alone, and writing it here would replace the conversation's
        // real session — destroying exactly the continuity the isolation is
        // meant to protect, and leaving the next human message to resume a
        // session that only ever saw a cron prompt.
        if (!isolated && ev.sessionId && ev.sessionId !== conv.claude_session_id) {
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
        closeQuestions()
        if (!ev.pending) closeRuns('done', { result: resultText })
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

        // Auto-title after any turn while the chat still carries the
        // placeholder — a manually set title is never touched. It used to run
        // only within the first three messages, so a first turn that errored,
        // was interrupted, or was a bare greeting left the chat untitled for
        // good. Now every finished turn is another chance until one sticks.
        const current = getDb()
          .prepare('SELECT title, model FROM conversations WHERE id = ?')
          .get(conversationId) as { title: string; model: string | null } | undefined

        if (!isolated && current?.title === UNTITLED) {
          generateTitle(conversationId, current.model).then((title) => {
            if (title) applyTitle(conversationId, title)
          })
        }
      }

      if (ev.type === 'error') {
        dropLive()
        console.log(`[msg] error: ${ev.message.slice(0, 120)}`)
        // Close out the turn either way — a new one may follow on this stream.
        msgId = null
        lines = []
        closeQuestions()

        // Skip error message if this was a user-initiated cancellation.
        // stopRun already marked its own run `stopped`, and finishRun won't
        // overwrite a closed row — this call is for a conversation-level
        // cancel that swept up an inherited run it didn't know the id of.
        if (cancelledConversations.has(conversationId)) {
          console.log(`[msg] cancelled — skipping error message`)
          cancelledConversations.delete(conversationId)
          closeRuns('interrupted', { error: 'Cancelled' })
          return
        }

        // Same thing one level down. Stopping a single run interrupts only its
        // session, so the conversation-wide `cancelled` flag above never gets
        // set — and the SIGTERM surfaced as `Claude exited with code 143` in
        // the transcript, an error bubble for something the user just asked
        // for. The run row is the record of intent; read it instead of
        // keeping a second flag in sync with it.
        if ([...attached.runIds].some((id) => runStatus(id) === 'stopped')) {
          console.log(`[msg] run stopped — skipping error message`)
          closeRuns('interrupted')
          return
        }

        // Create error message
        const errorMsgId = uuid()
        console.log(
          `[msg] db INSERT error ${errorMsgId}: ${ev.message.slice(0, 80)}`,
        )
        getDb()
          .prepare(
            'INSERT INTO messages (id, conversation_id, role, type, content, metadata) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(errorMsgId, conversationId, 'assistant', 'error', ev.message, runMetadata())

        closeRuns('error', { error: ev.message })

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

  streamConversation(streamKey, onEvent, () => {
    // Stream ended server-side (session closed / legacy turn finished) —
    // drop the guard so the next message re-attaches. If a pending done kept
    // the spinner on and the session died before its wake-up turn, this is
    // the safety net that turns it off.
    dropLive()
    attachedConversations.delete(streamKey)
    closeQuestions()
    // The session is gone, so nothing will ever report on these runs again.
    // Anything still open here died with it — say so rather than leave a Stop
    // button wired to a session that no longer exists.
    closeRuns('interrupted', { error: 'The engine session ended mid-run' })
    emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// answerQuestion — the person decides, the turn resumes.
// ─────────────────────────────────────────────────────────────────────────────

export interface AnswerBody {
  request_id: string
  /** AskUserQuestion: answer per question, keyed by the question text. */
  answers?: Record<string, string>
  /** Any other tool: approve or deny the call. */
  behavior?: 'allow' | 'deny'
  /** Free text — a reason for a denial, or an answer typed instead of picked. */
  message?: string
  /** Files sent with a typed answer, already uploaded — referenced for Claude like a message's. */
  attachments?: Attachment[]
}

/**
 * Answer the conversation's pending question. The answer goes to the engine as
 * the control response the CLI is waiting for, and into the transcript as the
 * person's message — so the record reads question, answer, what happened next.
 *
 * `answered: false` with a reason when the engine has nothing to answer any
 * more (its session died, or the prompt was withdrawn); the pending state is
 * dropped and the run closed as lost, since nobody will consume the answer.
 */
export async function answerQuestion(
  conversationId: string,
  body: AnswerBody,
): Promise<{ answered: boolean; error?: string }> {
  const q = getPendingQuestion(conversationId)
  if (!q) return { answered: false, error: 'Nothing is waiting for an answer.' }
  if (q.request_id !== body.request_id) {
    return { answered: false, error: 'That question is no longer the one being asked.' }
  }

  const questions = questionsOf(q)
  let answer: Parameters<typeof answerPrompt>[2]
  let said: string
  if (questions.length) {
    const answers: Record<string, string> = { ...(body.answers ?? {}) }
    // A typed answer to a single question needs no key from the client.
    if (questions.length === 1 && Object.keys(answers).length === 0 && body.message?.trim()) {
      answers[questions[0].question ?? ''] = body.message.trim()
    }
    if (Object.keys(answers).length === 0) return { answered: false, error: 'No answer given.' }
    said = questions.length === 1
      ? Object.values(answers)[0]
      : questions.map((x) => `${x.header || x.question}: ${answers[x.question ?? ''] ?? '—'}`).join('\n')
    // Files ride along on the last answered question's text, where the model
    // reads them next to the words they came with.
    const refs = attachmentRefs(body.attachments ?? [])
    if (refs) {
      const last = questions[questions.length - 1].question ?? ''
      answers[last] = `${answers[last] ?? ''}${refs}`
    }
    answer = { behavior: 'allow', updatedInput: { ...q.input, answers } }
  } else if (body.behavior === 'allow') {
    answer = { behavior: 'allow' }
    said = 'Approved.'
  } else if (body.behavior === 'deny') {
    answer = { behavior: 'deny', message: body.message?.trim() || undefined }
    said = body.message?.trim() ? `Denied: ${body.message.trim()}` : 'Denied.'
  } else {
    return { answered: false, error: 'Approve or deny it.' }
  }

  const res = await answerPrompt(q.session_key, q.request_id, answer)
  if (!res.ok) {
    if (res.gone) {
      console.warn(`[msg] ${conversationId}: prompt ${q.request_id} is gone — dropping it`)
      dropPendingQuestion(conversationId, q)
      return { answered: false, error: 'Jarvis is no longer waiting for this — the run it belonged to is gone.' }
    }
    return { answered: false, error: res.error }
  }

  // The person's message, in the transcript where the question was asked.
  // Stamped with the run like everything else the run wrote, so it stays inside
  // its card. Not through processMessage: the answer went by the control
  // channel, it must not also be sent as a new prompt.
  const msgId = uuid()
  const stamp = JSON.stringify({
    ...(q.run_id ? { run_id: q.run_id, isolated: q.session_key !== conversationId } : {}),
    answer_to: q.request_id,
    ...(body.attachments?.length ? { attachments: body.attachments } : {}),
  })
  getDb()
    .prepare('INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)')
    .run(msgId, conversationId, 'user', said, stamp)
  emitConversationEvent(conversationId, { type: 'message', message: getMessageRow(msgId) })
  // What follows belongs below the answer, in a new assistant message.
  markSteerPending(q.session_key)
  // The engine's ask_done clears the pending state through the stream; doing it
  // here too covers a stream that is not attached at the moment.
  setPendingQuestion(conversationId, null)
  return { answered: true }
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
  // Set when the session being resumed is an isolated run's rather than the
  // conversation's own — see reconnectActiveSessions in index.ts.
  options?: { runKey?: string; runId?: string },
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

  attachConversationStream(conversationId, conv, {
    runKey: options?.runKey,
    isolated: !!options?.runKey,
    runId: options?.runId,
  })
}

export async function conversationRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  // Endpoints a share link may drive, so the shared view can be the real chat
  // UI rather than a parallel implementation. Each is confined to the link's
  // own conversation; see share-access.ts for the whole allowlist.
  const sharedRead = { onRequest: [ownerOrShare(app, 'read')] }
  const sharedWrite = { onRequest: [ownerOrShare(app, 'write')] }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  // `result IS NOT NULL` is what makes a reply count only once it is *finished*.
  // The assistant row is INSERTed on the turn's first tool/chunk event and only
  // given its result on `done`, so without this the badge appeared the instant
  // Claude started thinking — any list refresh mid-turn (a tab regaining focus
  // is enough) counted a turn that had not said anything yet.
  app.get('/', auth, async () => {
    return getDb()
      .prepare(
        `SELECT c.*,
        (SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id = c.id
           AND m.role = 'assistant'
           AND m.type IS NULL
           AND m.result IS NOT NULL
           AND m.created_at > COALESCE(c.last_read_at, 0)
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
      .prepare(
        `INSERT INTO conversations (id, title, model, effort, last_read_at, notify)
         VALUES (?, ?, ?, ?, unixepoch(), 'auto')`,
      )
      // model = null → "use the global default" (resolved at invoke time)
      .run(id, title ?? 'New conversation', null, 'high')
    return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id)
  })

  // Returns the conversation with its most recent page of messages. `limit`
  // lets a reconnecting client ask for everything it had already loaded, so
  // catching up doesn't throw away the pages it scrolled back through.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/:id',
    sharedRead,
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
             AND m.result IS NOT NULL
             AND m.created_at > COALESCE(c.last_read_at, 0)
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
  }>('/:id/messages', sharedRead, async (req, reply) => {
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
      thinking?: boolean | number
      section_id?: string | null
    }
    const { title, notify, model, effort, thinking } = body

    const sets: string[] = []
    const params: unknown[] = []

    if (title !== undefined) {
      sets.push('title = ?')
      params.push(title)
    }
    if (thinking !== undefined) {
      sets.push('thinking = ?')
      params.push(thinking ? 1 : 0)
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

      // Moving between Anthropic and a gateway invalidates the CLI session:
      // resuming it makes the CLI cite a message id the new provider never
      // issued, and the turn fails. The engine handles this for a warm
      // session; clearing the stored id covers the cold one, where nothing
      // else knows which provider that transcript belonged to. Jarvis keeps
      // its own history, so only the CLI's context carry-over is lost.
      const previous = getDb()
        .prepare('SELECT model, claude_session_id FROM conversations WHERE id = ?')
        .get(req.params.id) as { model: string | null; claude_session_id: string | null } | undefined
      const wasGateway = !!previous?.model?.includes('/')
      const nowGateway = !!model?.includes('/')
      if (previous?.claude_session_id && wasGateway !== nowGateway) {
        sets.push('claude_session_id = NULL')
      }
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

  // DELETE /:id?files=delete&routines=delete
  //
  // By default the chat's files (its app, its uploads) are archived rather than
  // deleted, so a chat removed by mistake can be recovered from the file
  // browser, and its routines are left in place — the FK sets their
  // conversation_id to NULL and the next fire opens a fresh chat. Either
  // choice is the person's to make in the delete dialog, not the default.
  app.delete<{ Params: { id: string }; Querystring: { files?: string; routines?: string } }>(
    '/:id',
    auth,
    async (req, reply) => {
      const conv = getDb()
        .prepare('SELECT app_path FROM conversations WHERE id = ?')
        .get(req.params.id) as ConvRow | undefined
      if (!conv) return reply.code(404).send({ error: 'Not found' })

      if (req.query.routines === 'delete') {
        const db = getDb()
        const crons = db.prepare('DELETE FROM crons WHERE conversation_id = ?').run(req.params.id)
        db.prepare('DELETE FROM webhooks WHERE conversation_id = ?').run(req.params.id)
        if (crons.changes) rescheduleAll()
      }

      if (req.query.files === 'delete') {
        purgeConversationFiles(req.params.id, conv.app_path)
      } else {
        if (conv.app_path) archiveAppDir(req.params.id, conv.app_path)
        archiveUploadsDir(req.params.id)
      }

      getDb().prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id)
      return { ok: true }
    },
  )

  // ── Conversation sharing ───────────────────────────────────────────────────

  // GET /:id/share — current share state for this conversation.
  app.get<{ Params: { id: string } }>('/:id/share', auth, async (req, reply) => {
    const row = getDb()
      .prepare('SELECT share_token, share_mode FROM conversations WHERE id = ?')
      .get(req.params.id) as
      | { share_token: string | null; share_mode: string | null }
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { mode: row.share_mode, token: row.share_mode ? row.share_token : null }
  })

  // PUT /:id/share — enable, change mode, or disable ({ mode: null }).
  app.put<{ Params: { id: string } }>('/:id/share', auth, async (req, reply) => {
    const { mode, rotate } = (req.body ?? {}) as {
      mode?: 'read' | 'write' | null
      rotate?: boolean
    }
    if (mode !== null && mode !== 'read' && mode !== 'write') {
      return reply.code(400).send({ error: 'mode must be "read", "write" or null' })
    }

    const row = getDb()
      .prepare('SELECT share_token FROM conversations WHERE id = ?')
      .get(req.params.id) as { share_token: string | null } | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })

    if (mode === null) {
      // Disabling clears the token too: re-sharing later should not silently
      // reactivate a link the owner believed they had revoked.
      getDb()
        .prepare(
          'UPDATE conversations SET share_mode = NULL, share_token = NULL WHERE id = ?',
        )
        .run(req.params.id)
      return { mode: null, token: null }
    }

    const token = rotate || !row.share_token ? generateShareToken() : row.share_token
    getDb()
      .prepare('UPDATE conversations SET share_mode = ?, share_token = ? WHERE id = ?')
      .run(mode, token, req.params.id)
    return { mode, token }
  })

  // ── App share link ─────────────────────────────────────────────────────────

  // GET /:id/app-token — the conversation's share token, minted on first ask.
  app.get<{ Params: { id: string } }>('/:id/app-token', sharedRead, async (req, reply) => {
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
      const { id } = req.params
      try {
        await verifySession(req)
      } catch {
        // EventSource can't set headers, so the credential rides in the query.
        // A share link is accepted here too — a shared conversation that never
        // updated until reload would be a worse lie than not sharing at all —
        // but only for the conversation that link belongs to.
        const token = req.query.token ?? null
        const share = resolveShareToken(token)
        if (share) {
          if (share.conv.id !== id) {
            return reply.code(403).send({ error: 'This link does not open that conversation' })
          }
        } else {
          if (!token) return reply.code(401).send({ error: 'Unauthorized' })
          // An API key streams too: following a turn is most of what a script
          // does after posting a message, and polling would be the alternative.
          if (!userForApiKey(token)) {
            try {
              app.jwt.verify(token)
            } catch {
              return reply.code(401).send({ error: 'Unauthorized' })
            }
          }
        }
      }

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

      // Runs are pushed on change, so a client connecting between changes would
      // otherwise learn about an in-flight run only when it ended. Always sent,
      // empty list included — that is what clears a stale pill.
      reply.raw.write(
        `data: ${JSON.stringify({ type: 'runs', runs: activeRuns(id) })}\n\n`,
      )

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
      // A background run is work in this conversation that the conversation's
      // own engine session knows nothing about, so isRunning() answers `false`
      // for it. Without the second clause a refresh mid-cron dropped the
      // spinner and the Stop button while the run carried on invisibly.
      const running = (await isRunning(id)) || activeRuns(id).length > 0
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
          // Park below the newest assistant row *only if that row is the one
          // being written* — `result IS NULL` is what makes a turn unfinished,
          // since the result is only set on `done`.
          //
          // Leaving in the seconds between sending and the reply's first line
          // is the case this guards. There is no in-flight row yet, and simply
          // taking the newest assistant row hands back the *previous* turn's —
          // one already read — dragging the mark behind it and re-flagging a
          // reply the user had seen. That was an off-by-one (or more) marker on
          // every quick send-then-leave.
          //
          // With no row for this turn, now is the mark — minus a second, because
          // created_at has only second granularity and the comparison is a
          // strict `>`. A first line landing in the same second as the
          // disconnect would otherwise be read on arrival, losing the badge for
          // the whole reply, which is the failure this branch exists to prevent.
          getDb()
            .prepare(
              `UPDATE conversations SET last_read_at = COALESCE(
                 (SELECT m.created_at - 1 FROM messages m
                   WHERE m.conversation_id = ?
                     AND m.role = 'assistant'
                     AND m.type IS NULL
                     AND m.result IS NULL
                     AND m.rowid = (
                       SELECT MAX(m2.rowid) FROM messages m2
                        WHERE m2.conversation_id = ?
                          AND m2.role = 'assistant'
                          AND m2.type IS NULL
                     )),
                 unixepoch() - 1
               ) WHERE id = ?`,
            )
            .run(id, id, id)
        })
      })
    },
  )

  // ── Send message ───────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/:id/messages',
    sharedWrite,
    async (req, reply) => {
      const { id } = req.params
      const { content, attachments, model, effort, reply_to } = req.body as {
        content?: string
        attachments?: Attachment[]
        model?: string
        effort?: string
        reply_to?: { message_id?: unknown; text?: unknown }
      }

      const conv = getDb()
        .prepare('SELECT * FROM conversations WHERE id = ?')
        .get(id) as ConvRow | undefined
      if (!conv) return reply.code(404).send({ error: 'Not found' })

      if (!content?.trim() && !attachments?.length) {
        return reply.code(400).send({ error: 'Empty message' })
      }

      // A quote must point at a message of this very conversation and stay a
      // passage, not a pasted document.
      let replyTo: ReplyTo | undefined
      if (reply_to) {
        const { message_id, text } = reply_to
        if (typeof message_id !== 'string' || typeof text !== 'string' || !text.trim()) {
          return reply.code(400).send({ error: 'reply_to needs message_id and text' })
        }
        const owned = getDb()
          .prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?')
          .get(message_id, id)
        if (!owned) return reply.code(400).send({ error: 'reply_to.message_id is not in this conversation' })
        replyTo = { message_id, text: text.trim().slice(0, 2000) }
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
          replyTo,
        },
      )
      return { id: userMsgId }
    },
  )

  // ── Answer a question / approve a tool call ────────────────────────────────

  // Owner only: a share link can talk to the chat, not decide on its behalf.
  app.post<{ Params: { id: string } }>('/:id/answer', auth, async (req, reply) => {
    const conv = getDb()
      .prepare('SELECT id FROM conversations WHERE id = ?')
      .get(req.params.id) as { id: string } | undefined
    if (!conv) return reply.code(404).send({ error: 'Not found' })
    const body = (req.body ?? {}) as Partial<AnswerBody>
    if (typeof body.request_id !== 'string') {
      return reply.code(400).send({ error: 'request_id is required' })
    }
    return answerQuestion(req.params.id, body as AnswerBody)
  })

  // ── Cancel ─────────────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>('/:id/cancel', sharedWrite, async (req) => {
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
