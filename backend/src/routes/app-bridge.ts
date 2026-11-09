import type { FastifyInstance } from 'fastify'
import { getDb, normalizeEffort } from '../db.js'
import { invokeAndWait } from '../engine.js'
import { config } from '../config.js'
import type { ConvRow, WebhookRow } from '../types.js'
import { fireWebhook, fireWebhookSync } from '../webhooks.js'

/** Past this an app is sending a document, not asking a question. */
const MAX_PROMPT = 20_000
const TIMEOUT_MS = 120_000

/**
 * The server half of `window.jarvis.ask` (app-jarvis-bridge.ts): a one-off
 * answer for an app, from Jarvis with its tools, that never enters the chat.
 * Called by the Jarvis UI on the app's behalf, with the owner's session — the
 * app itself holds nothing that could reach this.
 */
export async function appBridgeRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  app.post<{ Params: { id: string } }>('/:id/ask', {
    ...auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const conv = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) as ConvRow | undefined
    if (!conv) return reply.code(404).send({ error: 'Not found' })
    const { prompt } = (req.body ?? {}) as { prompt?: unknown }
    if (typeof prompt !== 'string' || !prompt.trim()) return reply.code(400).send({ error: 'prompt is required' })
    if (prompt.length > MAX_PROMPT) return reply.code(400).send({ error: `prompt is too long (max ${MAX_PROMPT} characters)` })

    const framed = [
      '<article data-jarvis="app-ask">',
      `A question from the app beside the chat "${conv.title}" (conversation ${conv.id}), asked by the app's code. It was not typed in the chat, and the answer goes back to the app, not into the chat.`,
      'Answer only what is asked, in the format asked — plain text unless the question says otherwise (JSON, a number, one word). No preamble, no sign-off.',
      'If it depends on what was said in the chat, read it:',
      `curl -s -H "X-Internal-Secret: $INTERNAL_SECRET" "${config.internalUrl}/internal/conversations/${conv.id}/messages?limit=20"`,
      '</article>',
      '',
      prompt.trim(),
    ].join('\n')

    let timer: ReturnType<typeof setTimeout> | undefined
    const answer = await Promise.race([
      invokeAndWait({
        prompt: framed,
        sessionId: null,
        // Its own short-lived session, never the chat's.
        conversationId: `ask-${conv.id}-${Date.now()}`,
        model: conv.model ?? undefined,
        effort: normalizeEffort(conv.effort),
        // Paths and API calls built from it point at the chat, not the throwaway key.
        envVars: { JARVIS_CONVERSATION_ID: conv.id },
      }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), TIMEOUT_MS) }),
    ])
    clearTimeout(timer)
    if (answer === null) return reply.code(504).send({ error: 'No answer in time' })
    if (!answer.trim()) return reply.code(502).send({ error: 'No answer' })
    return { answer: answer.trim() }
  })

  // `window.jarvis.run(name, payload)`: fire one of the routines that report
  // into this chat — and only those, so an app reaches its own automations and
  // nothing else of the owner's. `sync` waits for the run's answer.
  app.post<{ Params: { id: string } }>('/:id/run', {
    ...auth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { name, payload, sync } = (req.body ?? {}) as { name?: unknown; payload?: unknown; sync?: unknown }
    if (typeof name !== 'string' || !name) return reply.code(400).send({ error: 'name is required' })
    const row = getDb()
      .prepare('SELECT * FROM webhooks WHERE name = ? AND conversation_id = ? AND enabled = 1')
      .get(name, req.params.id) as WebhookRow | undefined
    if (!row) return reply.code(404).send({ error: `No enabled webhook "${name}" reports into this chat` })
    const body = payload && typeof payload === 'object' && Object.keys(payload).length > 0 ? payload : undefined
    if (sync === true) {
      try {
        return { ok: true, answer: await fireWebhookSync(row, body) }
      } catch {
        return reply.code(504).send({ error: 'No answer in time' })
      }
    }
    fireWebhook(row, body)
    return { ok: true }
  })
}
