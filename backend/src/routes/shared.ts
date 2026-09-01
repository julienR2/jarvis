/**
 * Public routes for shared conversations.
 *
 * Unauthenticated by design: the share token in the URL *is* the credential.
 * Everything here is therefore written to expose one conversation and nothing
 * else — no listing, no ids that address other routes, and only the message
 * fields the read-only view renders.
 *
 * A 'write' share lets a visitor send messages, which spends the owner's Claude
 * budget and runs their agent. That is the point of an editable link, but it is
 * why enabling it is a deliberate choice in the UI rather than the default.
 */
import type { FastifyInstance } from 'fastify'
import { getDb, normalizeEffort } from '../db.js'
import { secureEquals } from '../security.js'
import { subscribeConversation } from '../sse.js'
import {
  processMessage,
  fetchMessagePage,
  parsePageLimit,
} from './conversations.js'
import { ensureAppToken } from '../app-tokens.js'
import type { ConvRow } from '../types.js'

/**
 * Resolve a share token to its conversation.
 *
 * The token is looked up by index, then confirmed with a constant-time compare:
 * SQLite's own comparison short-circuits, which would leak through timing
 * whether a guessed prefix matches a real token.
 */
function conversationForShareToken(token: string): ConvRow | null {
  if (!token) return null
  const row = getDb()
    .prepare('SELECT * FROM conversations WHERE share_token = ?')
    .get(token) as ConvRow | undefined
  if (!row?.share_token || !row.share_mode) return null
  return secureEquals(token, row.share_token) ? row : null
}

/**
 * Only what the stripped view renders — never session ids, notify settings or
 * anything addressing another conversation.
 *
 * When the conversation has an app, the link includes it: a shared chat whose
 * whole point is the thing it built would be strange without it. That is the
 * app's own scoped token, so rotating the app link revokes this too.
 */
function publicConversation(conv: ConvRow) {
  const slug = conv.app_path?.replace(/^apps\//, '') ?? null
  const appToken = slug ? ensureAppToken(conv.id) : null
  return {
    title: conv.title,
    mode: conv.share_mode,
    app_url:
      slug && appToken
        ? `/api/apps/${slug}/index.html?token=${appToken}`
        : null,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
  }
}

export async function sharedRoutes(app: FastifyInstance) {
  // Unauthenticated and internet-facing: cap them well below the global limit.
  const limit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }

  // GET /:token — the conversation and its most recent page of messages.
  app.get<{ Params: { token: string }; Querystring: { limit?: string } }>(
    '/:token',
    limit,
    async (req, reply) => {
      const conv = conversationForShareToken(req.params.token)
      if (!conv) return reply.code(404).send({ error: 'Not found' })
      const page = fetchMessagePage(conv.id, parsePageLimit(req.query.limit))
      return { ...publicConversation(conv), ...page }
    },
  )

  // GET /:token/messages — older pages, same cursor contract as the private API.
  app.get<{
    Params: { token: string }
    Querystring: { before?: string; limit?: string }
  }>('/:token/messages', limit, async (req, reply) => {
    const conv = conversationForShareToken(req.params.token)
    if (!conv) return reply.code(404).send({ error: 'Not found' })
    const before = Number(req.query.before)
    return fetchMessagePage(
      conv.id,
      parsePageLimit(req.query.limit),
      Number.isFinite(before) && before > 0 ? before : undefined,
    )
  })

  // POST /:token/messages — reply into the conversation. 'write' shares only.
  app.post<{ Params: { token: string } }>(
    '/:token/messages',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const conv = conversationForShareToken(req.params.token)
      if (!conv) return reply.code(404).send({ error: 'Not found' })
      if (conv.share_mode !== 'write') {
        return reply.code(403).send({ error: 'This link is read-only' })
      }

      const { content } = (req.body ?? {}) as { content?: string }
      if (!content?.trim()) {
        return reply.code(400).send({ error: 'Empty message' })
      }

      // No attachments and no model/effort override: a visitor picks neither
      // what runs nor what gets uploaded to the owner's instance.
      const id = processMessage(conv.id, conv, content.trim(), [], {
        model: conv.model ?? undefined,
        effort: normalizeEffort(conv.effort),
      })
      return { id }
    },
  )

  // GET /:token/events — SSE, so a shared view updates live like the real one.
  app.get<{ Params: { token: string } }>(
    '/:token/events',
    limit,
    async (req, reply) => {
      const conv = conversationForShareToken(req.params.token)
      if (!conv) return reply.code(404).send({ error: 'Not found' })

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      reply.raw.write('\n')
      reply.hijack()

      const unsubscribe = subscribeConversation(conv.id, (data) => {
        reply.raw.write(`data: ${data}\n\n`)
      })
      const heartbeat = setInterval(() => {
        reply.raw.write(': heartbeat\n\n')
      }, 30000)

      req.raw.on('close', () => {
        unsubscribe()
        clearInterval(heartbeat)
      })
    },
  )
}
