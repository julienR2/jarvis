import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { getDb, uuid } from '../db.js'
import { generateApiKey, hashApiKey, keyHint } from '../api-keys.js'
import type { ApiKeyRow } from '../types.js'
import type { Identity } from '../request-auth.js'

/** What the UI is allowed to see: everything except the secret itself. */
function present(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  }
}

export async function apiKeyRoutes(app: FastifyInstance) {
  /**
   * Managing keys takes a session, never a key.
   *
   * Otherwise a leaked key could mint a second one and survive the revocation
   * of the first — the loop that turns one bad afternoon into a permanent
   * foothold. Signing in is a low bar for something you do a handful of times.
   */
  const sessionOnly = {
    onRequest: [
      app.authenticate,
      async (req: FastifyRequest, reply: FastifyReply) => {
        if ((req.user as Identity)?.via === 'api-key') {
          reply.code(403).send({
            error: 'API keys cannot manage API keys — sign in to the web UI to do that.',
          })
        }
      },
    ],
  }

  app.get('/', sessionOnly, async (req) => {
    const { id } = req.user as Identity
    const rows = getDb()
      .prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
      .all(id) as ApiKeyRow[]
    return rows.map(present)
  })

  // The one and only time the key itself is returned. It is not stored in a
  // recoverable form, so a lost key is replaced, not looked up.
  app.post('/', sessionOnly, async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string }
    const label = (name ?? '').trim()
    if (!label) return reply.code(400).send({ error: 'name is required' })
    if (label.length > 80) return reply.code(400).send({ error: 'name is too long' })

    const { id: userId } = req.user as Identity
    const key = generateApiKey()
    const id = uuid()
    getDb()
      .prepare(
        'INSERT INTO api_keys (id, user_id, name, key_hash, prefix) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, userId, label, hashApiKey(key), keyHint(key))

    const row = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow
    return { ...present(row), key }
  })

  app.delete<{ Params: { id: string } }>('/:id', sessionOnly, async (req, reply) => {
    const { id: userId } = req.user as Identity
    const res = getDb()
      .prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?')
      .run(req.params.id, userId)
    if (res.changes === 0) return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })
}
