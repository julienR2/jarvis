import type { FastifyInstance } from 'fastify'
import { getDb, normalizeEffort } from '../db.js'
import { invokeAndWait } from '../engine.js'
import { config } from '../config.js'
import type { ConvRow } from '../types.js'

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
}
