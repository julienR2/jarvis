import { getDb, uuid } from './db.js'
import { processMessage } from './routes/conversations.js'
import type { WebhookRow, ConvRow } from './types.js'

function ensureConversation(entry: WebhookRow): { conversationId: string; conv: ConvRow } {
  if (entry.conversation_id) {
    const conv = getDb()
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(entry.conversation_id) as ConvRow | undefined
    if (conv) {
      return { conversationId: conv.id, conv }
    }
  }

  const convId = uuid()
  const notify = entry.notify ?? 'auto'
  const convNotify = notify === 'auto' ? 'auto' : notify === 'never' ? 'unsubscribe' : 'subscribe'
  getDb()
    .prepare('INSERT INTO conversations (id, title, notify) VALUES (?, ?, ?)')
    .run(convId, `Webhook: ${entry.name}`, convNotify)

  getDb()
    .prepare('UPDATE webhooks SET conversation_id = ? WHERE id = ?')
    .run(convId, entry.id)
  entry.conversation_id = convId

  const conv = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as ConvRow
  return { conversationId: convId, conv }
}

export function fireWebhook(entry: WebhookRow, payload?: unknown): void {
  console.log(`[webhook] firing "${entry.name}"`)
  _fireWebhook(entry, payload)
}

export function fireWebhookSync(entry: WebhookRow, payload?: unknown): Promise<string> {
  console.log(`[webhook] firing sync "${entry.name}"`)
  return _fireWebhook(entry, payload, true) as Promise<string>
}

function _fireWebhook(entry: WebhookRow, payload?: unknown, sync?: boolean): Promise<string> | void {
  getDb()
    .prepare('UPDATE webhooks SET last_run = unixepoch() WHERE id = ?')
    .run(entry.id)

  const { conversationId, conv } = ensureConversation(entry)

  let prompt = entry.prompt
  if (payload !== undefined && payload !== null) {
    prompt += `\n\nWebhook payload:\n${JSON.stringify(payload, null, 2)}`
  }

  // Extract display message from payload if user_message_key is set
  const userMessageKey = entry.user_message_key
  let displayMessage: string | undefined
  if (userMessageKey && payload && typeof payload === 'object') {
    const val = (payload as Record<string, unknown>)[userMessageKey]
    if (typeof val === 'string' && val.trim()) {
      displayMessage = val.trim()
    }
  }

  const msgOptions = {
    skipUserMessage: !displayMessage,
    userMessageOverride: displayMessage,
    model: entry.model ?? undefined,
    thinking: !!entry.thinking,
  }

  const donePromise = sync
    ? new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Webhook response timeout')), 120_000)
        processMessage(conversationId, conv, prompt, [], {
          ...msgOptions,
          onDone: (text) => {
            clearTimeout(timeout)
            getDb()
              .prepare('UPDATE webhooks SET last_result = ? WHERE id = ?')
              .run(text, entry.id)
            resolve(text)
          },
        })
      })
    : undefined

  if (!sync) {
    processMessage(conversationId, conv, prompt, [], {
      ...msgOptions,
      onDone: (text) => {
        getDb()
          .prepare('UPDATE webhooks SET last_result = ? WHERE id = ?')
          .run(text, entry.id)
      },
    })
  }

  return donePromise
}
