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
  getDb()
    .prepare('INSERT INTO conversations (id, title) VALUES (?, ?)')
    .run(convId, `Webhook: ${entry.name}`)

  getDb()
    .prepare('UPDATE webhooks SET conversation_id = ? WHERE id = ?')
    .run(convId, entry.id)
  entry.conversation_id = convId

  const conv = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as ConvRow
  return { conversationId: convId, conv }
}

export function fireWebhook(entry: WebhookRow, payload?: unknown): void {
  console.log(`[webhook] firing "${entry.name}"`)

  getDb()
    .prepare('UPDATE webhooks SET last_run = unixepoch() WHERE id = ?')
    .run(entry.id)

  const { conversationId, conv } = ensureConversation(entry)

  let prompt = entry.prompt
  if (payload !== undefined && payload !== null) {
    prompt += `\n\nWebhook payload:\n${JSON.stringify(payload, null, 2)}`
  }

  processMessage(conversationId, conv, prompt, [], {
    skipUserMessage: true,
    onDone: (text) => {
      getDb()
        .prepare('UPDATE webhooks SET last_result = ? WHERE id = ?')
        .run(text, entry.id)
    },
  })
}
