import type { FastifyInstance } from 'fastify'
import { getDb, uuid } from '../db.js'
import { processMessage } from './conversations.js'
import { consolidationPrompt, ensureDossierConversation, getSection, MAX_CONTEXT_CHARS, setSectionContext } from '../topics.js'
import { emitGlobalEvent } from '../sse.js'
import type { SectionRow } from '../types.js'

const MAX_NAME = 60

/** Trim + clamp a section name, or null when it's empty. */
function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const name = v.trim().slice(0, MAX_NAME)
  return name || null
}

export async function sectionRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  // Ties broken by created_at so two sections sharing a position stay stable.
  const listSections = () =>
    getDb()
      .prepare('SELECT * FROM sections ORDER BY position ASC, created_at ASC')
      .all() as SectionRow[]

  app.get('/', auth, async () => listSections())

  app.post('/', auth, async (req, reply) => {
    const name = cleanName((req.body as { name?: string })?.name)
    if (!name) return reply.code(400).send({ error: 'name is required' })

    const { max } = getDb()
      .prepare('SELECT COALESCE(MAX(position), -1) AS max FROM sections')
      .get() as { max: number }

    const id = uuid()
    getDb()
      .prepare('INSERT INTO sections (id, name, position) VALUES (?, ?, ?)')
      .run(id, name, max + 1)
    return getDb().prepare('SELECT * FROM sections WHERE id = ?').get(id) as SectionRow
  })

  app.get<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const section = getSection(req.params.id)
    if (!section) return reply.code(404).send({ error: 'Not found' })
    return section
  })

  // Rename, rewrite the brief, or both. A rewrite stamps context_updated_at so
  // the topic's warm chats pick the new text up on their next turn.
  app.patch<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; context?: unknown; brief_hidden?: unknown }
    const name = body.name !== undefined ? cleanName(body.name) : undefined
    if (body.name !== undefined && !name) return reply.code(400).send({ error: 'name is required' })
    if (body.context !== undefined && typeof body.context !== 'string') {
      return reply.code(400).send({ error: 'context must be a string' })
    }
    if (body.brief_hidden !== undefined && typeof body.brief_hidden !== 'boolean') {
      return reply.code(400).send({ error: 'brief_hidden must be a boolean' })
    }
    if (name === undefined && body.context === undefined && body.brief_hidden === undefined) {
      return reply.code(400).send({ error: 'Nothing to update' })
    }
    if (!getSection(req.params.id)) return reply.code(404).send({ error: 'Not found' })

    if (name) {
      getDb().prepare('UPDATE sections SET name = ? WHERE id = ?').run(name, req.params.id)
      emitGlobalEvent({ type: 'sections' })
    }
    if (typeof body.context === 'string') {
      if (body.context.length > MAX_CONTEXT_CHARS * 2) {
        return reply.code(400).send({ error: `context is too long (max ${MAX_CONTEXT_CHARS} characters)` })
      }
      setSectionContext(req.params.id, body.context)
    }
    if (typeof body.brief_hidden === 'boolean') {
      getDb().prepare('UPDATE sections SET brief_hidden = ? WHERE id = ?').run(body.brief_hidden ? 1 : 0, req.params.id)
      emitGlobalEvent({ type: 'sections' })
    }
    return getSection(req.params.id) as SectionRow
  })

  /**
   * Ask Jarvis to rewrite the topic's brief from its recent chats. Runs as an
   * ordinary turn in the topic's dossier chat, so it streams, can be stopped,
   * and leaves a record; the caller gets the chat to watch it in.
   */
  app.post<{ Params: { id: string } }>('/:id/consolidate', auth, async (req, reply) => {
    const section = getSection(req.params.id)
    if (!section) return reply.code(404).send({ error: 'Not found' })
    const conv = ensureDossierConversation(section)
    processMessage(conv.id, conv, consolidationPrompt(section, conv.id), [], {
      userMessageOverride: `Consolidate the brief of ${section.name}.`,
    })
    emitGlobalEvent({ type: 'sections' })
    return { conversation_id: conv.id }
  })

  // Full ordered list of ids rather than one position at a time — idempotent, and
  // it can't leave gaps or duplicate positions behind. Unknown ids are ignored;
  // sections the client didn't send keep their relative order after the sent ones.
  app.put('/order', auth, async (req, reply) => {
    const { ids } = (req.body as { ids?: unknown }) ?? {}
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return reply.code(400).send({ error: 'ids must be an array of section ids' })
    }

    const known = new Set(listSections().map((s) => s.id))
    const ordered = (ids as string[]).filter((id) => known.has(id))
    const update = getDb().prepare('UPDATE sections SET position = ? WHERE id = ?')
    getDb().transaction(() => {
      ordered.forEach((id, i) => update.run(i, id))
      // Anything not listed lands after the explicit order, keeping its own order.
      let next = ordered.length
      for (const s of listSections()) {
        if (!ordered.includes(s.id)) update.run(next++, s.id)
      }
    })()

    return listSections()
  })

  // Conversations in the section fall back to the default group (section_id NULL)
  // through the ON DELETE SET NULL foreign key — nothing is lost.
  app.delete<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const result = getDb().prepare('DELETE FROM sections WHERE id = ?').run(req.params.id)
    if (result.changes === 0) return reply.code(404).send({ error: 'Not found' })
    emitGlobalEvent({ type: 'sections' })
    return { ok: true }
  })
}
