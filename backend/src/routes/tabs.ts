import type { FastifyInstance } from 'fastify'
import { createReadStream, existsSync } from 'fs'
import { getDb } from '../db.js'
import { addTopicDoc, closeTab, docContentType, emitTabs, getTab, listTabs, openTab, resolveDocPath, updateTab } from '../tabs.js'

/**
 * The owner's side of a chat's tabs (see tabs.ts). Registered under
 * /api/conversations, next to the conversation routes. Not open to share
 * links: a tab can point at any document in the workspace.
 */
export async function tabRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }
  const exists = (id: string) => !!getDb().prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)

  app.get<{ Params: { id: string } }>('/:id/tabs', auth, async (req, reply) => {
    if (!exists(req.params.id)) return reply.code(404).send({ error: 'Not found' })
    return { tabs: listTabs(req.params.id) }
  })

  // Opened from the chat — a click on a file link. Unpinned unless asked.
  app.post<{ Params: { id: string } }>('/:id/tabs', auth, async (req, reply) => {
    if (!exists(req.params.id)) return reply.code(404).send({ error: 'Not found' })
    const body = (req.body ?? {}) as { kind?: string; target?: string; title?: string; pinned?: boolean }
    if (body.kind !== 'doc' && body.kind !== 'link') return reply.code(400).send({ error: 'kind must be doc or link' })
    if (!body.target) return reply.code(400).send({ error: 'target is required' })
    const result = openTab(req.params.id, { kind: body.kind, target: body.target, title: body.title, pinned: body.pinned })
    if ('error' in result) return reply.code(400).send(result)
    emitTabs(req.params.id)
    return { tab: result.tab, tabs: listTabs(req.params.id) }
  })

  // A topic's document is changed on the topic, not from one of its chats.
  const TOPIC_DOC = { error: "This document is pinned to the topic: remove it there" }

  app.patch<{ Params: { id: string; tabId: string } }>('/:id/tabs/:tabId', auth, async (req, reply) => {
    const tab = getTab(req.params.id, req.params.tabId)
    if (!tab) return reply.code(404).send({ error: 'Not found' })
    if (tab.topic) return reply.code(409).send(TOPIC_DOC)
    const { pinned, title } = (req.body ?? {}) as { pinned?: boolean; title?: string }
    updateTab(tab, { pinned, title })
    emitTabs(req.params.id)
    return { tabs: listTabs(req.params.id) }
  })

  app.delete<{ Params: { id: string; tabId: string } }>('/:id/tabs/:tabId', auth, async (req, reply) => {
    const tab = getTab(req.params.id, req.params.tabId)
    if (!tab) return reply.code(404).send({ error: 'Not found' })
    if (tab.topic) return reply.code(409).send(TOPIC_DOC)
    closeTab(tab)
    emitTabs(req.params.id)
    return { tabs: listTabs(req.params.id) }
  })

  // Share one of the chat's tabs with its topic: it becomes the topic's
  // document — a tab in every chat of the topic — and leaves this chat's own.
  app.post<{ Params: { id: string; tabId: string } }>('/:id/tabs/:tabId/topic', auth, async (req, reply) => {
    const tab = getTab(req.params.id, req.params.tabId)
    if (!tab) return reply.code(404).send({ error: 'Not found' })
    if (tab.topic) return { tabs: listTabs(req.params.id) }
    const conv = getDb()
      .prepare(`SELECT COALESCE(c.section_id, p.section_id) AS section_id FROM conversations c LEFT JOIN conversations p ON p.id = c.parent_id WHERE c.id = ?`)
      .get(req.params.id) as { section_id: string | null } | undefined
    if (!conv?.section_id) return reply.code(400).send({ error: 'This chat is not in a topic' })
    const result = addTopicDoc(conv.section_id, { kind: tab.kind, target: tab.target, title: tab.title })
    if ('error' in result) return reply.code(400).send(result)
    closeTab(tab)
    emitTabs(req.params.id)
    return { tab: getTab(req.params.id, result.doc.id), tabs: listTabs(req.params.id) }
  })

  // A document tab's file. Re-checked on every read — the file may have
  // moved, grown or been replaced by a symlink since the tab was opened. Run
  // in a sandbox (no script, no same-origin) wherever it is opened, this tab
  // or a new one: an HTML or SVG document is content, not an app.
  app.get<{ Params: { id: string; tabId: string } }>('/:id/tabs/:tabId/content', auth, async (req, reply) => {
    const tab = getTab(req.params.id, req.params.tabId)
    if (!tab || tab.kind !== 'doc') return reply.code(404).send({ error: 'Not found' })
    const r = resolveDocPath(tab.target)
    if ('error' in r || !existsSync(r.path)) return reply.code(404).send({ error: 'error' in r ? r.error : 'Not found' })
    const type = docContentType(r.path)
    reply.header('Content-Type', type).header('Cache-Control', 'no-store')
    // Chrome's PDF viewer refuses to run in a sandboxed document.
    if (type !== 'application/pdf') reply.header('Content-Security-Policy', 'sandbox')
    return reply.send(createReadStream(r.path))
  })
}
