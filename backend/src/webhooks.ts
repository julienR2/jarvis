import { getDb, uuid } from './db.js'
import { processMessage, type Attachment } from './routes/conversations.js'
import { startRun } from './runs.js'
import { ensureThread, threadNotifyOf } from './threads.js'
import { unarchiveConversation } from './archive.js'
import { emitGlobalEvent } from './sse.js'
import { UNTITLED } from './titles.js'
import type { ConvRow, WebhookRow } from './types.js'

/** The key a call names its thread by: `thread_key` in its payload. */
function threadKeyOf(payload: unknown): string | null {
  const key = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).thread_key : undefined
  return typeof key === 'string' && key.trim() ? key.trim().slice(0, 200) : null
}

/**
 * Where a call runs. Usually the routine's own conversation, every call one
 * after the other. A webhook set to open a thread per call (an email
 * processor: one thread per email) gets a new conversation each time, under
 * the chat it is attached to — or under its own conversation when it is
 * attached to none — titled from what the run says. A call with a
 * `thread_key` already seen goes back into that thread instead (a reply in
 * the same email exchange), brought back from the Archive if need be, and
 * resumes its session: the run knows what was said there before.
 */
function fireTarget(entry: WebhookRow, payload: unknown): { conv: ConvRow; resume: boolean } {
  const home = ensureThread('webhooks', entry, threadNotifyOf(entry.notify))
  if (!entry.thread_per_fire) return { conv: home, resume: false }
  const db = getDb()
  const key = threadKeyOf(payload)
  const fireKey = key ? `${entry.id}:${key}` : null
  if (fireKey) {
    const existing = db.prepare('SELECT * FROM conversations WHERE fire_key = ? ORDER BY created_at DESC LIMIT 1').get(fireKey) as ConvRow | undefined
    if (existing) {
      if (existing.archived_at) unarchiveConversation(existing.id)
      return { conv: { ...existing, archived_at: null }, resume: !!existing.claude_session_id }
    }
  }
  const parentId = (entry.conversation_id && db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(entry.conversation_id))
    ? entry.conversation_id
    : home.id
  const id = uuid()
  db.prepare(
    `INSERT INTO conversations (id, title, model, effort, last_read_at, notify, parent_id, fire_key)
     VALUES (?, ?, NULL, 'default', unixepoch(), ?, ?, ?)`,
  ).run(id, UNTITLED, home.notify, parentId, fireKey)
  emitGlobalEvent({ type: 'conversation_changed', conversation_id: id })
  return { conv: db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConvRow, resume: false }
}

export function fireWebhook(entry: WebhookRow, payload?: unknown): void {
  console.log(`[webhook] firing "${entry.name}"`)
  _fireWebhook(entry, payload)
}

/** What the share sheet hands a webhook: the shared text and link, and files already uploaded into its thread. */
export interface SharedContent {
  title?: string
  text?: string
  url?: string
  attachments?: Attachment[]
}

/**
 * Fire a webhook from the share sheet. The shared content is the run's own
 * message — text in the bubble, files as its attachments — so the thread shows
 * what was sent, unlike a payload from outside, which only the prompt sees.
 */
export function fireWebhookShare(entry: WebhookRow, shared: SharedContent): string {
  console.log(`[webhook] firing "${entry.name}" from the share sheet`)
  return _fireWebhook(entry, undefined, false, shared).conversationId
}

export function fireWebhookSync(entry: WebhookRow, payload?: unknown): Promise<string> {
  console.log(`[webhook] firing sync "${entry.name}"`)
  return _fireWebhook(entry, payload, true).done!
}

function _fireWebhook(
  entry: WebhookRow,
  payload?: unknown,
  sync?: boolean,
  shared?: SharedContent,
): { conversationId: string; done?: Promise<string> } {
  getDb()
    .prepare('UPDATE webhooks SET last_run = unixepoch() WHERE id = ?')
    .run(entry.id)

  const { conv: thread, resume } = fireTarget(entry, payload)
  const conversationId = thread.id

  let prompt = entry.prompt
  if (payload !== undefined && payload !== null) {
    prompt += `\n\nWebhook payload:\n${JSON.stringify(payload, null, 2)}`
  }

  const sharedText = shared ? [shared.title, shared.text, shared.url].filter((x) => x?.trim()).join('\n') : ''
  if (sharedText) prompt += `\n\nShared content:\n${sharedText}`
  const attachments = shared?.attachments ?? []

  // Extract display message from payload if user_message_key is set
  const userMessageKey = entry.user_message_key
  let displayMessage: string | undefined
  if (shared) {
    displayMessage = sharedText
  } else if (userMessageKey && payload && typeof payload === 'object') {
    const val = (payload as Record<string, unknown>)[userMessageKey]
    if (typeof val === 'string' && val.trim()) {
      displayMessage = val.trim()
    }
  }

  // See crons.ts: a fresh session per trigger, in the routine's thread.
  const runKey = `hook-${entry.id}-${Date.now()}`

  // Two fires of the same webhook land two runs in the same thread, in
  // parallel and by design. That only stays legible because each carries its
  // own id — the messages it writes are stamped with it, and Stop targets one
  // run rather than "whatever is running here".
  const run = startRun({
    kind: 'webhook',
    sourceId: entry.id,
    sourceName: entry.name,
    conversationId,
    runKey,
  })

  const recordDone = (text: string) => {
    getDb()
      .prepare('UPDATE webhooks SET last_result = ? WHERE id = ?')
      .run(text, entry.id)
  }

  const msgOptions = {
    // A share always shows its message: the files are on it, even with no text.
    skipUserMessage: !shared && !displayMessage,
    userMessageOverride: displayMessage,
    model: entry.model ?? undefined,
    effort: entry.effort,
    runKey,
    runId: run.id,
    routine: { name: entry.name, kind: 'webhook' as const },
    resumeSession: resume,
  }

  const donePromise = sync
    ? new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          // The caller gets an error, but the run itself is still going — the
          // timeout is on the HTTP response, not on the work. Leaving it
          // `running` is correct: it is, and it is still stoppable.
          reject(new Error('Webhook response timeout'))
        }, 120_000)
        processMessage(conversationId, thread, prompt, attachments, {
          ...msgOptions,
          onDone: (text) => {
            clearTimeout(timeout)
            recordDone(text)
            resolve(text)
          },
        })
      })
    : undefined

  if (!sync) {
    processMessage(conversationId, thread, prompt, attachments, {
      ...msgOptions,
      onDone: recordDone,
    })
  }

  return { conversationId, done: donePromise }
}
