import type { FastifyInstance } from 'fastify'
import { getDb } from '../db.js'

type Kind = 'conversation' | 'section' | 'webhook'

interface ShareTarget {
  kind: Kind
  target_id: string
}

/** The table each kind of pin points into. */
const TABLES: Record<Kind, string> = {
  conversation: 'conversations',
  section: 'sections',
  webhook: 'webhooks',
}

function exists(t: ShareTarget): boolean {
  return !!getDb().prepare(`SELECT 1 FROM ${TABLES[t.kind]} WHERE id = ?`).get(t.target_id)
}

/**
 * The share sheet's pins (see the share_targets table). Kept in the database
 * rather than on the device: they are set up in Settings on a laptop and used
 * from the share sheet of a phone.
 */
export async function shareTargetRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  // A pin outlives nothing: one whose chat, topic or webhook was deleted is
  // dropped here rather than by a trigger on three tables.
  app.get('/', auth, async () => {
    const rows = getDb()
      .prepare('SELECT kind, target_id FROM share_targets ORDER BY position ASC')
      .all() as ShareTarget[]
    const live = rows.filter(exists)
    if (live.length !== rows.length) {
      const drop = getDb().prepare('DELETE FROM share_targets WHERE kind = ? AND target_id = ?')
      for (const r of rows) if (!live.includes(r)) drop.run(r.kind, r.target_id)
    }
    return live
  })

  // The whole list, in order: pinning, unpinning and reordering are all one
  // write of what the Settings list now shows.
  app.put('/', auth, async (req, reply) => {
    const { targets } = (req.body ?? {}) as { targets?: ShareTarget[] }
    if (!Array.isArray(targets)) return reply.code(400).send({ error: 'targets is required' })
    for (const t of targets) {
      if (!t || !(t.kind in TABLES) || typeof t.target_id !== 'string') {
        return reply.code(400).send({ error: 'Invalid target' })
      }
      if (!exists(t)) return reply.code(400).send({ error: `Unknown ${t.kind}` })
    }
    const seen = new Set<string>()
    const unique = targets.filter((t) => {
      const key = `${t.kind}:${t.target_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const db = getDb()
    db.transaction(() => {
      db.prepare('DELETE FROM share_targets').run()
      const insert = db.prepare('INSERT INTO share_targets (kind, target_id, position) VALUES (?, ?, ?)')
      unique.forEach((t, i) => insert.run(t.kind, t.target_id, i))
    })()
    return unique.map(({ kind, target_id }) => ({ kind, target_id }))
  })
}
