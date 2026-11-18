import type { FastifyInstance } from 'fastify'
import { verifySession } from '../request-auth.js'
import { emitTabs } from '../tabs.js'
import { existsSync } from 'fs'
import { basename, extname, resolve, sep } from 'path'
import { getDb, uuid, normalizeEffort } from '../db.js'
import { activeRuns, finishRun, getRun, runStatus, stopRunsFor } from '../runs.js'
import { ownerOrShare, resolveShareToken } from '../share-access.js'
import { appAcceptsShares } from '../app-archive.js'
import { ensureAppToken, rotateAppToken, generateShareToken } from '../app-tokens.js'
import { UPLOADS_DIR, privatizeAttachments } from './uploads.js'
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
  reviewOf,
  questionsOf,
} from '../questions.js'
import { generateTitle, mediaTitle, UNTITLED } from '../titles.js'
import { resolveModel } from '../models.js'
import { forkEngineSession } from '../engine.js'
import { modelKind } from '../catalogue.js'
import { generateMedia } from '../media.js'
import { pushForConversation } from '../push.js'
import {
  emitConversationEvent,
  subscribeConversation,
  emitGlobalEvent,
} from '../sse.js'
import { config } from '../config.js'
import { DICTATION_ID_RE, dropDictation, finishDictation, transcribeFile } from '../stt.js'
import { getConnectorValues } from '../connectors.js'
import { topicContextFor } from '../topics.js'
import { MAX_SHORTCUTS } from '../shortcuts.js'
import { archiveConversation, purgeConversation, unarchiveConversation } from '../archive.js'
import { parentActivityPrompt, routineRunPrompt, setParent, threadActivityPrompt, threadContextPrompt } from '../threads.js'
import { SILENT_MARK, splitNotify } from '../runs.js'
import type { ConvRow, MessageRow, EffortLevel, PendingQuestion } from '../types.js'
import { userForApiKey } from '../api-keys.js'
import {
  ContextOverflowError,
  fitToContext,
  forgetLocalModels,
  inlineAttachment,
  isLocalModel,
  localConfig,
  localModelInfo,
  runTurn,
  tokenCounter,
  type ChatMessage,
} from '../local-llm.js'
import { isPrivateConversation, localModelOf, privateSql } from '../private.js'

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
  return answerOnly(
    getDb()
      .prepare('SELECT m.*, m.rowid AS seq FROM messages m WHERE m.id = ?')
      .get(id) as MessageRow,
  )
}

const STEP_MARKER = /^\[(tool|chunk|note)(?::\d+)?\] /

/**
 * A finished answer as the chat draws it, without the steps that led to it.
 *
 * `content` keeps every [tool]/[note] line of the turn — the database is the
 * record — but the chat stopped showing them, and in a long chat they were
 * most of what a page weighed. Once `result` is set only the prose is drawn:
 * the [chunk] lines, minus the last one, which the client drops because it
 * repeats `result` verbatim. So that last chunk leaves too, and an empty
 * `[chunk] ` stands in its place for the client to drop instead.
 *
 * A turn without a result is left whole: it is either still running, and its
 * latest step is the line by the loader, or it was cut off and has no answer
 * to stand in for its steps.
 */
function answerOnly(row: MessageRow): MessageRow {
  if (!row || row.role !== 'assistant' || !row.result || !STEP_MARKER.test(row.content)) return row
  const chunks: string[] = []
  let inChunk = false
  // Same split as the client's parser: an entry opens on a marker and runs on
  // through the paragraphs that follow it.
  for (const para of row.content.split('\n\n')) {
    const marker = para.match(STEP_MARKER)
    if (marker) {
      inChunk = marker[1] === 'chunk'
      if (inChunk) chunks.push(para)
    } else if (inChunk) {
      chunks[chunks.length - 1] += '\n\n' + para
    }
  }
  chunks.pop()
  return { ...row, content: [...chunks, '[chunk] '].join('\n\n') }
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
  return { messages: rows.reverse().map(answerOnly), has_more }
}

export function parsePageLimit(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return MESSAGE_PAGE_SIZE
  return Math.min(Math.floor(n), MAX_MESSAGE_PAGE_SIZE)
}

// What `unread_count` counts on a conversation row `c`: finished answers since
// it was last read, quiet ones aside.
const UNREAD_SQL = `(SELECT COUNT(*) FROM messages m
  WHERE m.conversation_id = c.id
    AND m.role = 'assistant'
    AND m.type IS NULL
    AND m.result IS NOT NULL
    AND m.created_at > COALESCE(c.last_read_at, 0)
    AND COALESCE(m.metadata, '') NOT LIKE '%"quiet":true%'
) AS unread_count`

// Track SSE clients per conversation for push notification decisions
const sseClients = new Map<string, number>()

// Chats marked unread, held that way until someone reads them on purpose:
// landing on the chat or reloading it (POST /:id/read), or writing in it.
// Marking happens from inside the chat, which stays open — so neither leaving
// it (the event stream's close) nor the resync a reconnect does (GET /:id)
// may mark it read meanwhile. In memory: a restart lets go of the hold, not of
// the unread state itself.
const heldUnread = new Set<string>()

// Track cancelled conversations to suppress error messages from SIGTERM
const cancelledConversations = new Set<string>()

export async function cancelConversation(conversationId: string): Promise<void> {
  cancelledConversations.add(conversationId)
  // A local turn is an HTTP stream from this process, not an engine session:
  // abort it, and anything queued behind it.
  cancelLocalTurns(conversationId)
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

/** The topic a conversation works for: its own, or that of the chat it hangs under, however deep. */
function topicSectionId(conv: ConvRow): string | null {
  let current: Pick<ConvRow, 'section_id' | 'parent_id'> | undefined = conv
  const seen = new Set<string>()
  while (current && !current.section_id && current.parent_id && !seen.has(current.parent_id)) {
    seen.add(current.parent_id)
    current = getDb().prepare('SELECT section_id, parent_id FROM conversations WHERE id = ?').get(current.parent_id) as
      | Pick<ConvRow, 'section_id' | 'parent_id'>
      | undefined
  }
  return current?.section_id ?? null
}

/** A passage the message replies to: of an earlier message of the chat, or —
 *  with no `message_id` — handed over by the chat's app (`jarvis.prefill`). */
export interface ReplyTo {
  message_id?: string
  text: string
}

/** A quote from a message stays a passage; one from the app may carry a whole
 *  item (an email, a record), which is the point of handing it over. */
const QUOTE_MAX = 2000
const APP_QUOTE_MAX = 8000

export function processMessage(
  conversationId: string,
  conv: ConvRow,
  userContent: string,
  attachmentsIn: Attachment[],
  options?: {
    skipUserMessage?: boolean
    userMessageOverride?: string
    // The quoted passage goes to Claude in its own article ahead of the text,
    // and is stored on the message's metadata for the bubble to show.
    replyTo?: ReplyTo
    // The text is a speech-to-text transcript, sent as-is: Claude is told to
    // read it charitably. The saved message stays the bare transcript.
    transcribed?: boolean
    onDone?: (text: string) => void
    // What this message runs on. Unset = the instance default.
    model?: string
    effort?: EffortLevel
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
    // Set for a routine's run in its thread. The run is told what it is and how
    // to stay quiet, and its thread takes over the run's session afterwards.
    // Who hears about it is decided when the run closes (threads.ts reportRun),
    // not by the notify prompt.
    routine?: { name: string; kind: 'cron' | 'webhook' }
    // A routine's run that goes on in a thread rather than starting fresh: a
    // webhook call back into the thread its key opened (webhooks.ts). Still
    // its own one-shot session, but resumed from the thread's, so it knows
    // what was said there.
    resumeSession?: boolean
  },
): string | null {
  let attachments = attachmentsIn
  // Writing in a conversation put away brings it back (and the chats above it).
  // A routine's run does not: archiving paused it, and one fired by hand
  // meanwhile leaves it where it is.
  if (conv.archived_at && !options?.runId) {
    unarchiveConversation(conversationId)
    conv.archived_at = null
  }

  // Slash commands pass through untouched — no notify prefix, no attachment refs.
  const isCommand = userContent.trim().startsWith('/')

  // Build the prompt fed to Claude. This is kept SEPARATE from userContent (the
  // text persisted to the DB and echoed to the client): the blocks wrapped
  // around it are instructions to the model, not what the person said.
  let claudePrompt = userContent

  if (conv.notify === 'auto' && !isCommand && !options?.routine) {
    const notifyInstruction = [
      '<article data-jarvis="notify-prompt">',
      '[NOTIFICATION DECISION REQUIRED]',
      'Decide how the user hears about your reply, with a marker at its very start. Without one, it shows as unread in this chat and nothing more.',
      '- [push: <one-line summary>] — it is worth a phone notification: something they are waiting on, time-sensitive, or that needs them. The summary is the notification text.',
      `- ${SILENT_MARK} — nothing to come back for (a pleasantry like "you're welcome", a bare acknowledgement): not unread, no notification.`,
      'Markers are removed before display. Do NOT mention this decision in your reply; it should only address the task.',
      '</article>',
    ].join('\n')
    claudePrompt = notifyInstruction + '\n' + claudePrompt
  }

  // The topic's brief, when this chat is filed under one and its session has
  // not seen the current text yet. Ephemeral like the notify block: the saved
  // message is what the person typed, not what the model was told around it.
  if (!isCommand) {
    // A thread has no section of its own; it works for the topic of the chat
    // it hangs under.
    const briefConv = { ...conv, section_id: topicSectionId(conv) }
    const brief = topicContextFor(briefConv, { freshSession: !!options?.runKey })
    if (brief) claudePrompt = brief + '\n' + claudePrompt
  }

  if (options?.routine && !isCommand) {
    const parent = conv.parent_id
      ? (getDb().prepare('SELECT id, title FROM conversations WHERE id = ?').get(conv.parent_id) as { id: string; title: string } | undefined)
      : undefined
    claudePrompt = `${routineRunPrompt(options.routine.name, options.routine.kind, parent)}\n${claudePrompt}`
  } else if (!options?.runId && !isCommand) {
    const threadNote = threadContextPrompt(conv)
    if (threadNote) claudePrompt = `${threadNote}\n${claudePrompt}`
    // A chat and its threads: each hears what the other did meanwhile (see
    // threadActivityPrompt). Read before the user row below is written: it is
    // "since the person last spoke".
    for (const block of [threadActivityPrompt(conversationId), parentActivityPrompt(conv)]) {
      if (block) claudePrompt = `${block}\n${claudePrompt}`
    }
  }

  if (options?.transcribed && !isCommand) {
    const note = [
      '<article data-jarvis="voice-transcript">',
      'The message below was dictated and sent straight from speech-to-text, unedited.',
      'Expect transcription errors (misheard or near-homophone words, wrong names, missing punctuation):',
      'read it for what was meant, and ask only if the meaning is really unclear.',
      '</article>',
    ].join('\n')
    claudePrompt = `${note}\n${claudePrompt}`
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
    const quote = (replyTo.message_id
      ? [
          `<article data-jarvis="reply-to" message="${replyTo.message_id}">`,
          'The user is replying to this passage of an earlier message in the conversation:',
        ]
      : [
          '<article data-jarvis="app-context">',
          "The user's message is about this, handed over by the chat's app (what it showed them):",
        ]
    ).concat(replyTo.text, '</article>').join('\n')
    claudePrompt = `${quote}\n${claudePrompt}`
  }

  // Resolved once: the same id is recorded on the messages and sent to the
  // engine, so what a bubble says ran is what did.
  //
  // A private conversation (one a local model has spoken in, see private.ts)
  // that is sent a message naming no model — a routine, a share, the agent's
  // relay — stays on its local model rather than taking the instance default.
  const privateConv = isPrivateConversation(conversationId)
  const model = resolveModel(options?.model ?? (privateConv ? localModelOf(conversationId) ?? undefined : undefined))
  const local = isLocalModel(model)
  // …and one that is explicitly sent to Claude or the gateway is refused: the
  // CLI would be one Read away from everything said here, and the person chose
  // this conversation because nothing in it leaves the machine.
  const refused = privateConv && !local
  const effort = local ? null : options?.effort ?? null
  // The local model reads files inline, and they must not wait in the agent's
  // workspace meanwhile: moved before the message records where they are.
  if (local && attachments.length) attachments = privatizeAttachments(conversationId, attachments)

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
        'INSERT INTO messages (id, conversation_id, role, content, metadata, model, effort) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(userMsgId, conversationId, 'user', savedContent, metadata, model, effort)

    const userRow = getMessageRow(userMsgId)
    console.log(
      `[msg] emit message (user) ${userMsgId}: ${userContent.slice(0, 80)}`,
    )
    emitConversationEvent(conversationId, { type: 'message', message: userRow })
    // Writing in a chat is reading it.
    if (!options?.routine) heldUnread.delete(conversationId)
  }

  // The conversation remembers the last model a person picked, as where the
  // input starts next time — nothing more: every message carries its own. A
  // routine's run never moves it, so a cron pinned to a cheap model doesn't
  // change what your next message runs on.
  if (options?.model !== undefined && !options?.runId && !refused) {
    getDb()
      .prepare('UPDATE conversations SET model = ?, effort = ?, updated_at = unixepoch() WHERE id = ?')
      .run(options.model, options.effort ?? 'default', conversationId)
  } else if (!options?.routine) {
    // A routine's run moves its conversation up only once it has news (see
    // threads.ts reportRun): an hourly "nothing new" must not keep it on top.
    getDb()
      .prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?')
      .run(conversationId)
  }

  // Emit thinking status
  console.log(`[msg] emit thinking: true`)
  emitConversationEvent(conversationId, { type: 'thinking', thinking: true })

  if (refused) {
    emitConversationError(
      conversationId,
      `This conversation is private: a local model has answered in it, so it can only continue on a local model — ${model} would send it off this machine. Pick a local model, or start a new chat.`,
    )
    emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
    if (options?.runId) finishRun(options.runId, 'error', { error: 'Private conversation: not run on a non-local model' })
    return userMsgId
  }

  // A local model isn't an agent either: the backend sends it the transcript
  // directly and streams the answer back (see runLocalTurn). Nothing of the
  // conversation reaches the engine.
  if (local) {
    queueLocalTurn(conversationId, conv, {
      model,
      userMsgId,
      content: userContent,
      attachments,
      replyTo,
      transcribed: !!options?.transcribed,
      onDone: options?.onDone,
      runId: options?.runId,
    })
    return userMsgId
  }

  // A media model isn't an agent: the message is a prompt for a picture or a
  // clip, so it goes straight to the gateway's media endpoint instead of the
  // CLI. Choosing an image model chooses the pipeline.
  modelKind(model)
    .then((kind) => {
      if (kind === 'text') return dispatchToAgent()
      return runMediaGeneration(conversationId, model, kind, userContent, options?.onDone)
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
    sessionId: isolated && !options?.resumeSession ? null : conv.claude_session_id,
    conversationId: runKey ?? conversationId,
    model,
    effort: options?.effort,
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
        model,
        routine: !!options?.routine,
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
        'INSERT INTO messages (id, conversation_id, role, content, result, metadata, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        conversationId,
        'assistant',
        text,
        text,
        JSON.stringify({ attachments: [media] }),
        model,
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
// Local turns — a conversation on the Local provider (local-llm.ts).
//
// No engine, no CLI, no agent: Jarvis's own transcript of the conversation goes
// to the local server as OpenAI `messages`, and the answer streams back into the
// same events and rows an agent turn produces — `delta` while it writes, one
// assistant message with its `result` when done — so the chat, titles, unread
// badges, pushes and share links treat it like any other.
//
// One turn at a time per conversation, queued: the server itself usually runs
// one request at a time, and a second message mid-answer has nothing to steer.
// ─────────────────────────────────────────────────────────────────────────────

interface LocalTurn {
  model: string
  /** The person's row for this turn; null when it wasn't saved (a routine's prompt). */
  userMsgId: string | null
  content: string
  attachments: Attachment[]
  replyTo?: ReplyTo
  transcribed: boolean
  onDone?: (text: string) => void
  runId?: string
}

const localTurns = new Map<string, AbortController>()
const localQueues = new Map<string, Promise<void>>()
// Bumped by Stop: queued turns that were waiting when it was pressed don't run.
const localStopGen = new Map<string, number>()

function queueLocalTurn(conversationId: string, conv: ConvRow, turn: LocalTurn): void {
  const gen = localStopGen.get(conversationId) ?? 0
  const prev = localQueues.get(conversationId) ?? Promise.resolve()
  const next = prev
    .then(() => {
      if ((localStopGen.get(conversationId) ?? 0) !== gen) {
        if (turn.runId) finishRun(turn.runId, 'interrupted', { error: 'Cancelled' })
        return
      }
      return runLocalTurn(conversationId, conv, turn)
    })
    .catch((err) => console.error('[local] turn failed outside its handler:', err))
  localQueues.set(conversationId, next)
  void next.finally(() => {
    if (localQueues.get(conversationId) === next) localQueues.delete(conversationId)
  })
}

function cancelLocalTurns(conversationId: string): void {
  if (!localQueues.has(conversationId) && !localTurns.has(conversationId)) return
  localStopGen.set(conversationId, (localStopGen.get(conversationId) ?? 0) + 1)
  localTurns.get(conversationId)?.abort()
}

/** Whether a turn is in flight here: the engine's, or a local one. */
async function turnRunning(conversationId: string): Promise<boolean> {
  return localTurns.has(conversationId) || localQueues.has(conversationId) || (await isRunning(conversationId))
}

function localSystemPrompt(): string {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: config.tz,
  })
  return [
    "You are Jarvis, the user's personal assistant, running entirely on their own machine: nothing in this conversation leaves it.",
    'You have no tools. You cannot browse, run code, send messages or open files — only read what is in this conversation, including files pasted in it between <file> tags.',
    'Answer in the language the user writes in. Be direct and accurate; when the text you were given does not say, say so rather than guess.',
    `Today is ${today}.`,
  ].join('\n')
}

/** A person's turn as the local model reads it: the files, the passage replied to, then what they said. */
function localUserText(content: string, attachments: Attachment[], replyTo?: ReplyTo, transcribed = false): string {
  const parts: string[] = []
  for (const a of attachments) parts.push(inlineAttachment(a))
  if (replyTo?.text) {
    parts.push(`Replying to this passage:\n${replyTo.text.split('\n').map((l) => `> ${l}`).join('\n')}`)
  }
  if (transcribed) parts.push('(Dictated with speech-to-text: expect misheard words.)')
  if (content.trim()) parts.push(content)
  return parts.join('\n\n')
}

/**
 * The conversation so far, as chat messages. Finished answers only — their
 * `result`, not the step log — and the person's messages with their files
 * inlined again: a chat export shared in the first message is what every later
 * question is about. Same-role neighbours are merged, since several chat
 * templates (Gemma's among them) refuse a conversation whose roles don't
 * alternate — and an errored turn leaves two user messages in a row.
 */
function localHistory(conversationId: string, current: string | null): ChatMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.rowid AS seq, m.role, m.content, m.result, m.metadata FROM messages m
        WHERE m.conversation_id = ? AND m.type IS NULL
        ORDER BY m.created_at ASC, m.rowid ASC`,
    )
    .all(conversationId) as { id: string; seq: number; role: string; content: string; result: string | null; metadata: string | null }[]
  const currentSeq = current ? rows.find((r) => r.id === current)?.seq ?? Infinity : Infinity
  const out: ChatMessage[] = []
  for (const r of rows) {
    if (r.id === current) continue
    let text = ''
    if (r.role === 'user') {
      // Sent after this turn's message (queued behind it): not history yet.
      if (r.seq > currentSeq) continue
      let meta: { attachments?: Attachment[]; reply_to?: ReplyTo } = {}
      try {
        meta = r.metadata ? JSON.parse(r.metadata) : {}
      } catch { /* no metadata worth reading */ }
      text = localUserText(r.content ?? '', meta.attachments ?? [], meta.reply_to)
    } else if (r.role === 'assistant') {
      text = (r.result ?? '').trim()
    }
    if (!text) continue
    const role = r.role === 'user' ? 'user' : 'assistant'
    const last = out[out.length - 1]
    if (last?.role === role) last.content += `\n\n${text}`
    else out.push({ role, content: text })
  }
  return out
}

/** "about 4 min" / "about 40 s" — a remaining-time estimate, deliberately rough. */
function roughDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${Math.max(5, Math.round(s / 5) * 5)} s`
  return `${Math.round(s / 60)} min`
}

const fmtTokens = (n: number) => n.toLocaleString('en-US')

/** Below this a prompt is read in a few seconds and needs no status line. */
const READING_STATUS_MIN_TOKENS = 1500

async function runLocalTurn(conversationId: string, conv: ConvRow, turn: LocalTurn): Promise<void> {
  const ctl = new AbortController()
  localTurns.set(conversationId, ctl)
  emitConversationEvent(conversationId, { type: 'thinking', thinking: true })
  let text = ''
  const notes: string[] = []
  // The turn's assistant row. Created early only when the prompt is long
  // enough for reading it to take a while: it carries the "Reading…" status,
  // which the chat shows next to the loader (liveStatus), so minutes of prompt
  // reading on a home server don't look like a hang. Its status line is
  // replaced by the answer when it lands; the record keeps only real notes.
  let rowId: string | null = null
  const content = (lines: string[]) => lines.map((n) => `[note] ${n}`)
  const emitRow = () => emitConversationEvent(conversationId, { type: 'message', message: getMessageRow(rowId!) })
  const showStatus = (status: string) => {
    // Once answer text streams, the status is over — and any row update now
    // would make the client drop the live text it is typing out.
    if (text || ctl.signal.aborted) return
    const body = content([...notes, status]).join('\n\n')
    if (!rowId) {
      rowId = uuid()
      getDb()
        .prepare('INSERT INTO messages (id, conversation_id, role, content, metadata, model) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rowId, conversationId, 'assistant', body, turn.runId ? JSON.stringify({ run_id: turn.runId, isolated: false }) : null, turn.model)
    } else {
      getDb().prepare('UPDATE messages SET content = ? WHERE id = ?').run(body, rowId)
    }
    emitRow()
  }
  // The answer, written into the status row or as a new one. The prose is a
  // `[chunk]` line, as an agent turn writes it: the chat draws an assistant row
  // from its content's lines (the last chunk standing for `result`), and a row
  // without any shows its raw content.
  const writeAnswer = (result: string) => {
    const body = [...content(notes), `[chunk] ${result}`].join('\n\n')
    if (rowId) {
      getDb().prepare('UPDATE messages SET content = ?, result = ? WHERE id = ?').run(body, result, rowId)
    } else {
      rowId = uuid()
      getDb()
        .prepare('INSERT INTO messages (id, conversation_id, role, content, result, metadata, model) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(rowId, conversationId, 'assistant', body, result, turn.runId ? JSON.stringify({ run_id: turn.runId, isolated: false }) : null, turn.model)
    }
    liveTurnText.delete(conversationId)
    emitRow()
  }
  let ticker: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null

  try {
    if (!getDb().prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) return
    const cfg = localConfig()
    if (!cfg) {
      throw new Error('No local model server is configured any more (Settings → Connection → Local), and this conversation only runs on one.')
    }

    // Named before it is answered, and only then — see localTitle in titles.ts.
    const titled = getDb().prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string } | undefined
    if (titled?.title === UNTITLED) {
      const t = await generateTitle(conversationId, turn.model)
      if (t) applyTitle(conversationId, t)
    }

    const info = await localModelInfo(cfg, turn.model)

    let history = localHistory(conversationId, turn.userMsgId)
    let current = localUserText(turn.content, turn.attachments, turn.replyTo, turn.transcribed)
    // A question that never got an answer (its turn failed) is part of this one.
    if (history[history.length - 1]?.role === 'user') {
      current = `${history[history.length - 1].content}\n\n${current}`
      history = history.slice(0, -1)
    }

    const budget = await fitToContext({
      system: localSystemPrompt(),
      history,
      current,
      contextWindow: info.contextWindow,
      count: tokenCounter(cfg),
    })
    if (budget.dropped > 0) {
      notes.push(
        `Left out the ${budget.dropped} oldest message${budget.dropped > 1 ? 's' : ''}: the local model's ${Math.round(info.contextWindow / 1024)}k-token context can't hold the whole conversation.`,
      )
    }
    console.log(
      `[local] ${conversationId.slice(0, 8)}: ${turn.model}, ~${budget.promptTokens} prompt tokens of ${info.contextWindow}, ${budget.messages.length} messages${budget.dropped ? `, ${budget.dropped} dropped` : ''}`,
    )

    // "Reading…" while the server reads the prompt. With llama-server's
    // progress events it is a percentage and an estimate of what is left;
    // without them, the time spent so far, so a long wait still visibly moves.
    // The plain status waits a few seconds first: a follow-up whose prompt the
    // server still has cached is answering by then, and a "Reading 23,000
    // tokens…" flashing up for it would be untrue.
    const started = Date.now()
    let progressed = false
    let lastShown = 0
    let sample: { at: number; done: number } | null = null
    if (budget.promptTokens >= READING_STATUS_MIN_TOKENS) {
      const plain = () => {
        if (progressed) return
        const elapsed = Date.now() - started
        showStatus(
          `Reading about ${fmtTokens(budget.promptTokens)} tokens…${elapsed >= 10_000 ? ` (${roughDuration(elapsed)} so far)` : ''}`,
        )
      }
      ticker = setTimeout(() => {
        plain()
        ticker = setInterval(plain, 15_000)
      }, 4000)
    }

    const result = await runTurn(cfg, {
      model: turn.model,
      messages: budget.messages,
      maxTokens: budget.maxTokens,
      signal: ctl.signal,
      onProgress: (p) => {
        const fresh = p.total - p.cached
        const done = p.processed - p.cached
        // Mostly cached (a follow-up question): nothing worth a status line.
        if (fresh < READING_STATUS_MIN_TOKENS || done >= fresh) return
        progressed = true
        // From the recent rate, not the average: reading slows down as the
        // context fills (measured: ~4 min left at 9%, seven in truth, with the
        // average), so the latest stretch is the better guide to the rest.
        const prev = sample
        if (!prev || p.ms - prev.at >= 5000) sample = { at: p.ms, done }
        if (Date.now() - lastShown < 3000) return
        lastShown = Date.now()
        const pct = Math.floor((done / fresh) * 100)
        const rate = prev && done > prev.done && p.ms > prev.at ? (p.ms - prev.at) / (done - prev.done) : done > 0 && p.ms > 0 ? p.ms / done : null
        const left = rate !== null ? (fresh - done) * rate : null
        showStatus(
          `Reading ${fmtTokens(fresh)} tokens — ${pct}%${left !== null ? `, about ${roughDuration(left)} left` : ''}` +
            (p.cached > 50 ? ` (${fmtTokens(p.cached)} already read earlier)` : ''),
        )
      },
      onDelta: (t) => {
        if (ticker) {
          clearTimeout(ticker)
          clearInterval(ticker)
          ticker = null
        }
        text += t
        emitConversationEvent(conversationId, { type: 'delta', text: t })
        liveTurnText.set(conversationId, (liveTurnText.get(conversationId) ?? '') + t)
      },
    })

    // The context gauge, as for an agent turn: what the model just held.
    const contextTokens = result.usage ? result.usage.prompt + result.usage.completion : budget.promptTokens
    getDb()
      .prepare('UPDATE conversations SET context_tokens = ?, context_window = ? WHERE id = ?')
      .run(contextTokens, info.contextWindow, conversationId)
    emitConversationEvent(conversationId, { type: 'usage', contextTokens, contextWindow: info.contextWindow })

    let answer = result.text.trim()
    if (result.finishReason === 'length') {
      answer += '\n\n*(Cut off: the answer reached the length the local model is given.)*'
    }
    answer = answer.trim() || '(no response)'
    writeAnswer(answer)
    if (turn.runId) finishRun(turn.runId, 'done', { result: answer })
    turn.onDone?.(answer)

    // Pushed unless the chat is muted: a local answer takes minutes on a home
    // server, which is exactly when you have put the phone down — and there is
    // no notify marker to ask the model for. The push itself says nothing of
    // what was written (push.ts).
    if (conv.notify !== 'unsubscribe' && !turn.runId) {
      pushForConversation(conversationId, conv.title, '').catch((err) => console.error('[push] local turn:', err))
    }
    emitGlobalEvent({ type: 'new_message', conversation_id: conversationId })
  } catch (err: any) {
    const aborted = ctl.signal.aborted
    // The server refused the window it was told about: it may have been
    // restarted with another one. Ask it again next turn.
    if (err instanceof ContextOverflowError) forgetLocalModels()
    try {
      if (aborted) {
        // Stopped: keep what was written, marked as such.
        cancelledConversations.delete(conversationId)
        if (text.trim()) {
          notes.push('Stopped.')
          writeAnswer(text.trim())
        } else if (rowId) {
          writeAnswer('*(Stopped before the answer started.)*')
        }
        if (turn.runId) finishRun(turn.runId, 'interrupted', { error: 'Cancelled' })
      } else {
        const message = err instanceof ContextOverflowError ? err.message : `The local model failed: ${err?.message ?? err}`
        if (text.trim()) {
          notes.push('The answer was cut off by an error.')
          writeAnswer(text.trim())
          emitConversationError(conversationId, message)
        } else if (rowId) {
          // The status row becomes the error: no empty "Reading…" left behind.
          getDb().prepare(`UPDATE messages SET type = 'error', content = ?, result = NULL WHERE id = ?`).run(message, rowId)
          emitRow()
        } else {
          emitConversationError(conversationId, message)
        }
        if (turn.runId) finishRun(turn.runId, 'error', { error: message })
        emitGlobalEvent({ type: 'new_message', conversation_id: conversationId })
      }
    } catch (reportErr) {
      // The conversation was deleted mid-turn: nothing left to write into.
      console.error('[local] could not report the turn:', reportErr)
    }
  } finally {
    if (ticker) {
      clearTimeout(ticker)
      clearInterval(ticker)
    }
    if (localTurns.get(conversationId) === ctl) localTurns.delete(conversationId)
    liveTurnText.delete(conversationId)
    try {
      emitConversationEvent(conversationId, { type: 'thinking', thinking: false })
      getDb().prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(conversationId)
    } catch {
      /* conversation is gone */
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
    // Who answers: stamped on the assistant rows. Null when unknown (a stream
    // re-attached after a restart).
    model: string | null
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
    // Stamped on the assistant rows this stream writes: who answered.
    model?: string
    // A routine's run in its own thread: the thread adopts the run's session,
    // and the push is left to the run's report.
    routine?: boolean
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
    // A message steered into a running turn may have switched model: the
    // engine applies it in place, so what answers from here on is the new one.
    if (options?.model) existing.model = options.model
    return
  }
  const attached = {
    model: options?.model ?? null,
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
    detail?: { result?: string; error?: string; quiet?: boolean; push?: { summary: string | null } },
  ): boolean => {
    let quiet = attached.runIds.size > 0
    for (const id of attached.runIds) quiet = finishRun(id, status, detail) && quiet
    attached.runIds.clear()
    return quiet
  }
  // The turn just closed was a run with nothing to report: it prints nothing,
  // so it raises no badge and no push either.
  let quietTurn = false

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
    const current = getDb().prepare('SELECT notify FROM conversations WHERE id = ?').get(conv.id) as Pick<ConvRow, 'notify'> | undefined
    if ((current?.notify ?? conv.notify) !== 'unsubscribe') {
      pushForConversation(conv.id, `${conv.title} · needs you`, summary.slice(0, 200)).catch(
        (err) => console.error('[push] pushForConversation failed:', err),
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
          'INSERT INTO messages (id, conversation_id, role, content, metadata, model) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(msgId, conversationId, 'assistant', content, runMetadata(), attached.model)
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
        // The notify markers are an instruction to us, not text for the person.
        const { level, push, text: resultText } = splitNotify(ev.result || '')
        const silent = level === 'silent'
        console.log(`[msg] done — result: ${resultText.length} chars`)

        // Set result on the message
        if (!msgId) {
          // Claude produced a result without any tool/chunk events
          msgId = uuid()
          console.log(`[msg] db INSERT assistant ${msgId} (result only)`)
          getDb()
            .prepare(
              'INSERT INTO messages (id, conversation_id, role, content, result, metadata, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(msgId, conversationId, 'assistant', '', resultText, runMetadata(), attached.model)
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
        //
        // A routine's run is the exception: it ran in its own thread, so the
        // thread resumes it — replying there continues from the latest run.
        if ((!isolated || options?.routine) && ev.sessionId && ev.sessionId !== conv.claude_session_id) {
          console.log(`[msg] db UPDATE conversation session: ${ev.sessionId}`)
          getDb()
            .prepare(
              `UPDATE conversations SET claude_session_id = ?${options?.routine ? '' : ', updated_at = unixepoch()'} WHERE id = ?`,
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
        const wasRoutine = !!options?.routine
        if (attached.runIds.size > 0) {
          quietTurn = !ev.pending && closeRuns('done', { result: resultText, quiet: silent, push: push ?? undefined })
        } else if (silent && !ev.pending) {
          // A person's turn the model judged not worth coming back for: it
          // stays on screen, but raises no badge and no push.
          getDb()
            .prepare(`UPDATE messages SET metadata = json_set(COALESCE(metadata, '{}'), '$.quiet', json('true')) WHERE id = ?`)
            .run(msgId)
          emitConversationEvent(conversationId, { type: 'message', message: getMessageRow(msgId!) })
          quietTurn = true
        } else {
          quietTurn = false
        }
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
        // - unsubscribe: never send — the badge is all
        // - auto: the reply's own marker decides (see the notify prompt)
        const pushes = conv.notify === 'subscribe' || (conv.notify === 'auto' && level === 'push')
        if (pushes && !quietTurn && !wasRoutine) {
          const plain = resultText
            .replace(/#{1,6}\s+/g, '') // headings
            .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // bold/italic
            .replace(/`{1,3}[^`]*`{1,3}/g, '') // inline/block code
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
            .replace(/^[-*>]\s+/gm, '') // list markers, blockquotes
            .replace(/\n+/g, ' ')
            .trim()
            .slice(0, 200)
          pushForConversation(conversationId, conv.title, push?.summary || plain).catch(
            (err) => console.error('[push] pushForConversation failed:', err),
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

        // A routine's run titles a conversation too — one a webhook call
        // opened is untitled until its first answer says what it is about.
        if ((!isolated || options?.routine) && current?.title === UNTITLED) {
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

      // A routine's run reports when it closes (threads.ts reportRun), to the
      // chat it is attached to or as its own thread — not from here.
      if (!options?.routine && ((ev.type === 'done' && !quietTurn) || ev.type === 'error')) {
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
  /** review_text approved: the text as the person left it, edited or not. */
  text?: string
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
/** A text as a markdown blockquote, every line of it. */
function quoted(text: string): string {
  return text.trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')
}

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
  const review = reviewOf(q)
  let answer: Parameters<typeof answerPrompt>[2]
  let said: string
  // An approved draft's envelope, kept with the message so its bubble can say
  // where the text went, not just what it said.
  let approved: { edited: boolean; note?: string; to?: string; cc?: string; subject?: string; attachments?: string[] } | null = null
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
  } else if (review && body.behavior === 'allow') {
    // Their version goes back as the tool's input; the engine's handler tells
    // the model whether it was approved as is or edited (and re-asked).
    const text = typeof body.text === 'string' && body.text.trim() ? body.text : review.text
    const edited = text.trim() !== review.text.trim()
    answer = { behavior: 'allow', updatedInput: { ...q.input, text } }
    // The draft stays in the record as approved, the card above it gone.
    said = `${edited ? 'Edited and approved:' : 'Approved:'}\n\n${quoted(text)}`
    approved = {
      edited,
      ...(review.note ? { note: review.note } : {}),
      ...(review.to ? { to: review.to } : {}),
      ...(review.cc ? { cc: review.cc } : {}),
      ...(review.subject ? { subject: review.subject } : {}),
      ...(review.attachments.length ? { attachments: review.attachments } : {}),
    }
  } else if (review && body.behavior === 'deny' && !body.message?.trim() && !body.attachments?.length) {
    answer = { behavior: 'deny', message: 'The user discarded this draft. Do not send it.' }
    said = 'Discarded.'
  } else if (body.behavior === 'allow') {
    answer = { behavior: 'allow' }
    said = 'Approved.'
  } else if (body.behavior === 'deny') {
    // With words, a denial is a reply — what was typed in the composer while
    // the approval was up, as the CLI's own "No, and tell Claude what to do
    // differently". The model reads it as the tool's error, so it is framed
    // as the person speaking; the transcript keeps it as they wrote it.
    const reply = body.message?.trim() ?? ''
    const refs = attachmentRefs(body.attachments ?? [])
    answer = {
      behavior: 'deny',
      message: reply || refs
        ? `${review ? 'The user did not approve this text yet. They replied' : 'The user declined this and replied'}:\n${reply}${refs}`
        : undefined,
    }
    said = reply || (refs ? '' : 'Denied.')
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
    ...(approved ? { approved } : {}),
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
    routine: !!options?.runKey,
  })
}

/**
 * The model and effort a message asks for. Unset falls back to the model the
 * conversation last ran on. A share link can talk to the chat but not choose
 * what it runs on — that spends the owner's plan — so its picks are ignored.
 */
function messageModel(
  req: object,
  conv: ConvRow,
  model?: string,
  effort?: string,
): { model?: string; effort: EffortLevel } {
  // Set by ownerOrShare on a share-link request (see share-access.ts).
  if ((req as { share?: unknown }).share) {
    return { model: conv.model ?? undefined, effort: normalizeEffort(conv.effort) }
  }
  return { model: model || conv.model || undefined, effort: normalizeEffort(effort ?? conv.effort) }
}

/**
 * The routine that runs in this conversation, as `cron:<id>` or
 * `webhook:<id>`; NULL when none does.
 */
const THREAD_OF_SQL = `COALESCE(
          (SELECT 'cron:' || id FROM crons WHERE thread_id = c.id),
          (SELECT 'webhook:' || id FROM webhooks WHERE thread_id = c.id)
        ) AS thread_of`

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
        ${UNREAD_SQL},
        ${THREAD_OF_SQL},
        ${privateSql('c')} AS is_private,
        (SELECT COUNT(*) > 0 FROM runs WHERE conversation_id = c.id) AS has_runs
       FROM conversations c
       ORDER BY c.updated_at DESC`,
      )
      .all()
  })

  // A thread: a new conversation under this one that starts where this one is
  // (its Claude session forked, so it knows everything said so far). From a
  // passage, it opens with the person's message replying to it and is shown
  // at that message.
  app.post<{ Params: { id: string } }>('/:id/threads', auth, async (req, reply) => {
    const body = (req.body ?? {}) as {
      content?: string
      reply_to?: ReplyTo
      model?: string
      effort?: string
      attachments?: Attachment[]
    }
    const parent = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) as ConvRow | undefined
    if (!parent) return reply.code(404).send({ error: 'Not found' })
    const content = (body.content ?? '').trim()
    const quote = body.reply_to
    if (!content && !body.attachments?.length) return reply.code(400).send({ error: 'content is required' })
    // From a passage, or blank — a sub-chat started from the list. A blank
    // one still hangs off a message (the chat's latest), which is where its
    // fork happened and what keeps it a thread of this chat.
    let anchor: string
    let title: string
    if (quote) {
      if (!quote.message_id || !quote.text?.trim()) return reply.code(400).send({ error: 'reply_to needs message_id and text' })
      const source = getDb()
        .prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ?')
        .get(quote.message_id, parent.id)
      if (!source) return reply.code(400).send({ error: 'reply_to must be a message of this conversation' })
      anchor = quote.message_id
      const firstLine = quote.text.trim().split('\n')[0]
      title = firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine
    } else {
      const latest = getDb()
        .prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
        .get(parent.id) as { id: string } | undefined
      if (!latest) return reply.code(400).send({ error: 'Start the chat before opening a thread from it' })
      anchor = latest.id
      // Titled from its first exchange, like a new chat.
      title = UNTITLED
    }
    let { model, effort } = messageModel(req, parent, body.model, body.effort)
    // A thread of a private chat is private too: it runs on the chat's local
    // model whatever the composer had selected, and forks no engine session —
    // the chat's old Claude one, if it had any, predates what made it private.
    const privateParent = isPrivateConversation(parent.id)
    if (privateParent && !isLocalModel(model)) model = localModelOf(parent.id) ?? undefined
    const forked = !privateParent && parent.claude_session_id ? await forkEngineSession(parent.claude_session_id) : null
    const id = uuid()
    getDb()
      .prepare(
        `INSERT INTO conversations (id, title, model, effort, last_read_at, notify, parent_id, parent_message_id, claude_session_id)
         VALUES (?, ?, ?, ?, unixepoch(), 'auto', ?, ?, ?)`,
      )
      .run(id, title, model ?? null, effort ?? 'default', parent.id, anchor, forked)
    const conv = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConvRow
    processMessage(id, conv, content, body.attachments ?? [], {
      ...(quote ? { replyTo: { message_id: quote.message_id, text: quote.text.slice(0, QUOTE_MAX) } } : {}),
      model,
      effort,
    })
    emitGlobalEvent({ type: 'conversation_changed', conversation_id: id })
    return conv
  })

  app.post('/', auth, async (req, reply) => {
    const { title, section_id } = (req.body as { title?: string; section_id?: string | null }) ?? {}
    if (section_id && !getDb().prepare('SELECT 1 FROM sections WHERE id = ?').get(section_id)) {
      return reply.code(400).send({ error: 'Unknown section' })
    }
    const id = uuid()
    getDb()
      .prepare(
        `INSERT INTO conversations (id, title, model, effort, last_read_at, notify, section_id)
         VALUES (?, ?, ?, ?, unixepoch(), 'auto', ?)`,
      )
      // model = null → "use the global default" (resolved at invoke time);
      // effort 'default' → no --effort flag, the model decides.
      .run(id, title ?? 'New conversation', null, 'default', section_id || null)
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
          ${UNREAD_SQL},
          ${THREAD_OF_SQL},
        ${privateSql('c')} AS is_private,
          (SELECT COUNT(*) > 0 FROM runs WHERE conversation_id = c.id) AS has_runs
         FROM conversations c WHERE c.id = ?`,
        )
        .get(req.params.id)
      if (!conv) return reply.code(404).send({ error: 'Not found' })

      if (!heldUnread.has(req.params.id)) {
        getDb()
          .prepare(
            'UPDATE conversations SET last_read_at = unixepoch() WHERE id = ?',
          )
          .run(req.params.id)
      }

      const page = fetchMessagePage(req.params.id, parsePageLimit(req.query.limit))
      // Held unread: the count still stands, and the client keeps it.
      return { ...(conv as object), ...page, unread_held: heldUnread.has(req.params.id) }
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
      section_id?: string | null
      /** Hang it under another conversation, or (null) at the top level. */
      parent_id?: string | null
      /** Put away (Done), or bring back. */
      archived?: boolean
      /** Offer it as a launcher shortcut of the installed app, or stop. */
      shortcut?: boolean
    }
    const { title, notify } = body

    const target = getDb()
      .prepare('SELECT parent_id FROM conversations WHERE id = ?')
      .get(req.params.id) as Pick<ConvRow, 'parent_id'> | undefined
    if (!target) return reply.code(404).send({ error: 'Not found' })

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
    // Put away with everything under it, or brought back with it (archive.ts).
    if (body.archived !== undefined) {
      if (body.archived) archiveConversation(req.params.id)
      else unarchiveConversation(req.params.id)
    }
    if (body.shortcut === false) sets.push('shortcut_at = NULL')
    if (body.shortcut === true) {
      const taken = getDb()
        .prepare('SELECT COUNT(*) AS n FROM conversations WHERE shortcut_at IS NOT NULL AND id != ?')
        .get(req.params.id) as { n: number }
      if (taken.n >= MAX_SHORTCUTS) {
        return reply.code(409).send({ error: `Already ${MAX_SHORTCUTS} shortcuts — remove one in Settings first` })
      }
      // Kept if already set: re-adding must not move it to the end of the list.
      sets.push('shortcut_at = COALESCE(shortcut_at, unixepoch())')
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

    // Re-hung: under another conversation, or at the top level. Filed into a
    // group, a thread comes out from under its chat to sit there.
    const parentId = 'parent_id' in body ? body.parent_id ?? null : 'section_id' in body && target.parent_id ? null : undefined
    if (parentId !== undefined && parentId !== target.parent_id) {
      if (!setParent(req.params.id, parentId)) {
        return reply.code(400).send({ error: 'parent_id must be another conversation, not this one or one under it' })
      }
    } else if (sets.length === 0 && body.archived === undefined) {
      return reply.code(400).send({ error: 'Nothing to update' })
    }

    // Filing a chat isn't activity: bumping updated_at here would shuffle it to
    // the top of its new section, since sections sort by most recent activity.
    // Neither is putting it away, nor offering it as a shortcut.
    const onlyMoved = sets.every((s) => s === 'section_id = ?' || s.startsWith('shortcut_at'))
    if (!onlyMoved) sets.push('updated_at = unixepoch()')
    params.push(req.params.id)

    if (sets.length > (onlyMoved ? 0 : 1)) {
      const result = getDb()
        .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params)
      if (result.changes === 0)
        return reply.code(404).send({ error: 'Not found' })
    }
    // Another topic, other shared documents beside it.
    if ('section_id' in body) emitTabs(req.params.id)
    return getDb()
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(req.params.id)
  })

  // Mark read without opening: Today's "mark as read" on a chat's card. The
  // same stamp opening the chat sets; the sidebar count follows on the client.
  // Also what landing on a chat sends, so it is what ends an unread hold.
  app.post<{ Params: { id: string } }>('/:id/read', auth, async (req, reply) => {
    heldUnread.delete(req.params.id)
    const r = getDb()
      .prepare('UPDATE conversations SET last_read_at = unixepoch() WHERE id = ?')
      .run(req.params.id)
    if (r.changes === 0) return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })

  // Mark unread from a message on: the read mark goes back to just before it,
  // so it and every answer after it count again and the chat is back on Today
  // — and held there while the chat stays open (see heldUnread).
  app.post<{ Params: { id: string }; Body: { message_id?: string } }>('/:id/unread', auth, async (req, reply) => {
    const msg = getDb()
      .prepare('SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?')
      .get(req.body?.message_id ?? '', req.params.id) as { created_at: number } | undefined
    if (!msg) return reply.code(404).send({ error: 'Not found' })
    getDb()
      .prepare('UPDATE conversations SET last_read_at = ? WHERE id = ?')
      .run(msg.created_at - 1, req.params.id)
    heldUnread.add(req.params.id)
    return { ok: true }
  })

  // DELETE /:id — for good, now: the conversation, everything under it, their
  // files and the routines running in them. The app archives instead (PATCH
  // archived), and the Archive deletes after a week; this is for what was
  // never worth keeping, like a routine draft discarded.
  app.delete<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    if (!getDb().prepare('SELECT 1 FROM conversations WHERE id = ?').get(req.params.id)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    purgeConversation(req.params.id)
    return { ok: true }
  })

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

  // GET /:id/app-share — whether the chat's app takes what is shared to it.
  // The share picker asks before opening it: one that doesn't gets the share
  // in the chat's composer instead.
  app.get<{ Params: { id: string } }>('/:id/app-share', auth, async (req, reply) => {
    const conv = getDb()
      .prepare('SELECT app_path FROM conversations WHERE id = ?')
      .get(req.params.id) as Pick<ConvRow, 'app_path'> | undefined
    if (!conv) return reply.code(404).send({ error: 'Not found' })
    return { accepts: !!conv.app_path && appAcceptsShares(req.params.id, conv.app_path) }
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
      const running = (await turnRunning(id)) || activeRuns(id).length > 0
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
        turnRunning(id).then((running) => {
          // Marked unread and not read since: leaving is not reading. Checked
          // once isRunning answers, so a mark landing meanwhile counts.
          if (heldUnread.has(id)) return
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

      const quoted = checkReplyTo(id, reply_to)
      if (typeof quoted === 'string') return reply.code(400).send({ error: quoted })
      const replyTo = quoted

      // No busy check: a message sent while Claude works is steered into the
      // running turn (or queued) by the CLI — that's a feature now.
      const userMsgId = processMessage(
        id,
        conv,
        content?.trim() || '',
        attachments || [],
        {
          ...messageModel(req, conv, model, effort),
          replyTo,
        },
      )
      // The saved row too: a sender that isn't watching the chat's stream yet
      // (Today, opening the chat it just created) inserts it without waiting.
      return { id: userMsgId, message: getMessageRow(userMsgId!) }
    },
  )

  // A quote of a message must point at a message of this very conversation
  // and stay a passage, not a pasted document. Without a message it is what
  // the chat's app handed over (`jarvis.prefill`), and may be longer. A
  // string is what is wrong with it.
  function checkReplyTo(conversationId: string, raw: { message_id?: unknown; text?: unknown } | undefined): ReplyTo | undefined | string {
    if (!raw) return undefined
    const { message_id, text } = raw
    if (typeof text !== 'string' || !text.trim()) return 'reply_to needs text'
    if (message_id === undefined || message_id === null) return { text: text.trim().slice(0, APP_QUOTE_MAX) }
    if (typeof message_id !== 'string') return 'reply_to.message_id must be a string'
    const owned = getDb()
      .prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?')
      .get(message_id, conversationId)
    if (!owned) return 'reply_to.message_id is not in this conversation'
    return { message_id, text: text.trim().slice(0, QUOTE_MAX) }
  }

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
  // The local model first: it is the fast one. ElevenLabs, when connected,
  // stands in if it fails.
  async function transcribeAudioBuffer(buffer: Buffer): Promise<string> {
    const audioBlob = new Blob([new Uint8Array(buffer)], { type: 'audio/webm' })
    let transcript = ''
    let failure: Error | null = null

    try {
      transcript = await transcribeFile(audioBlob, 'audio.webm')
    } catch (err) {
      failure = err as Error
    }

    const elSecrets = getConnectorValues('elevenlabs')
    if (failure && elSecrets?.ELEVENLABS_API_KEY) {
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
          failure = null
        }
      } catch { /* report the local failure */ }
    }

    if (failure) throw new TranscriptionError(failure.message, 502)
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

  app.post<{ Params: { id: string }; Querystring: { model?: string; effort?: string } }>(
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

      // What else was in the composer comes as fields ahead of the file: text
      // typed before speaking, the attachments, the quote. Only fields sent
      // before the file are parsed by now — the client puts them first.
      const field = (name: string): string | undefined => {
        const f = file.fields[name]
        const one = Array.isArray(f) ? f[0] : f
        return one && one.type === 'field' && typeof one.value === 'string' ? one.value : undefined
      }
      let attachments: Attachment[] = []
      let rawReplyTo: { message_id?: unknown; text?: unknown } | undefined
      try {
        const a = field('attachments')
        if (a) attachments = JSON.parse(a)
        const r = field('reply_to')
        if (r) rawReplyTo = JSON.parse(r)
      } catch {
        return reply.code(400).send({ error: 'attachments and reply_to must be JSON' })
      }
      if (!Array.isArray(attachments)) return reply.code(400).send({ error: 'attachments must be a list' })
      const quoted = checkReplyTo(id, rawReplyTo)
      if (typeof quoted === 'string') return reply.code(400).send({ error: quoted })
      const typed = field('text')?.trim() ?? ''

      // Read the full upload while the client is connected. Once we hold the
      // buffer, transcription + message creation happen server-side, so the
      // client can navigate away or close the app without losing the message.
      const buffer = await file.toBuffer()

      // The reply waits for the transcription: the composer's "Transcribing…"
      // then lasts exactly as long as it does, and the person's bubble lands
      // the moment it ends, like a typed message. A client that leaves meanwhile
      // doesn't stop the handler — the message is still posted.
      try {
        const transcript = await transcribeAudioBuffer(buffer)
        return { message: postTranscript(id, conv, typed, transcript, attachments, quoted, req) }
      } catch (err) {
        console.error('[audio] transcription failed:', err)
        const message = `Audio transcription failed: ${(err as Error)?.message ?? err}`
        emitConversationError(id, message)
        emitConversationEvent(id, { type: 'thinking', thinking: false })
        return reply.code(err instanceof TranscriptionError ? err.status : 502).send({ error: message })
      }
    },
  )

  function postTranscript(
    id: string,
    conv: ConvRow,
    typed: string,
    transcript: string,
    attachments: Attachment[],
    quoted: ReplyTo | undefined,
    req: { query: { model?: string; effort?: string } },
  ) {
    const content = typed ? `${typed}\n\n${transcript}` : transcript
    const userMsgId = processMessage(id, conv, content, attachments, {
      transcribed: true,
      replyTo: quoted,
      ...messageModel(req, conv, req.query.model, req.query.effort),
    })
    return getMessageRow(userMsgId!)
  }

  // A voice message that streamed to the speech service while it was spoken
  // (POST /api/dictation): the service already has the audio, and most of it
  // transcribed. A 409 tells the client the service lacks part of it — it
  // sends the rest and asks again, nothing is posted meanwhile. Any other
  // failure isn't posted either: the client still holds the recording and
  // falls back to uploading it to /:id/audio, which reports its own.
  app.post<{
    Params: { id: string }
    Querystring: { model?: string; effort?: string }
    Body: { dictation?: string; length?: number; text?: string; attachments?: Attachment[]; reply_to?: unknown }
  }>('/:id/dictation', auth, async (req, reply) => {
    const { id } = req.params
    const conv = getDb()
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as ConvRow | undefined
    if (!conv) return reply.code(404).send({ error: 'Not found' })

    const { dictation, length, text, attachments = [], reply_to } = req.body ?? {}
    if (typeof dictation !== 'string' || !DICTATION_ID_RE.test(dictation) || !Number.isInteger(length)) {
      return reply.code(400).send({ error: 'dictation and length are required' })
    }
    if (!Array.isArray(attachments)) return reply.code(400).send({ error: 'attachments must be a list' })
    const quoted = checkReplyTo(id, reply_to as { message_id?: unknown; text?: unknown } | undefined)
    if (typeof quoted === 'string') return reply.code(400).send({ error: quoted })

    let answer
    try {
      answer = await finishDictation(dictation, length!)
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message })
    }
    if (answer.status === 409) return reply.code(409).send(answer.body)
    const transcript = 'transcript' in answer.body ? answer.body.transcript : ''
    if (!transcript) return reply.code(400).send({ error: 'No speech detected' })
    void dropDictation(dictation)
    return { message: postTranscript(id, conv, text?.trim() ?? '', transcript, attachments, quoted, req) }
  })
}
