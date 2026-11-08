/**
 * Tabs beside a chat: documents and links, shown in the side pane next to the
 * chat's app (if it has one).
 *
 * A document tab points at a file, it does not hold one: the file stays where
 * it lives (the chat's uploads, a dossier under memory/, the repo's docs/), so
 * Jarvis keeps editing it with its ordinary tools and any chat can open the
 * same one. While a document is open in some tab it is watched, and every
 * change is pushed to the chat — the pane re-renders as Jarvis writes.
 *
 * One tab per chat may be unpinned: the temporary one, replaced by the next
 * tab opened. That is what lets Jarvis open things on its own without the pane
 * filling up; pinning is how a tab is kept.
 */
import { existsSync, realpathSync, statSync, unwatchFile, watchFile } from 'fs'
import { basename, isAbsolute, join, resolve, sep } from 'path'
import { getDb, uuid } from './db.js'
import { config } from './config.js'
import { emitConversationEvent } from './sse.js'

export interface TabRow {
  id: string
  conversation_id: string
  kind: 'doc' | 'link'
  target: string
  title: string
  pinned: number
  created_at: number
}

const REPO_DIR = resolve(process.env.JARVIS_REPO_DIR || '/jarvis')
const WORKSPACE_DIR = resolve(config.workspaceDir)
/** Past this a document is a download, not something to render beside a chat. */
export const MAX_DOC_BYTES = 5 * 1024 * 1024

const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep)

/**
 * Where a document may come from: the workspace, or the repo outside the
 * agent's config dir (its data/ holds the database and the secrets). No dot
 * segment anywhere — `.env`, `.git`. Relative paths are read against the
 * workspace. Returns the resolved path, or why not.
 */
export function resolveDocPath(input: string): { path: string } | { error: string } {
  // Paths are written as the agent sees the workspace; read them against
  // this backend's own (the same on prod, a temp dir on a throwaway stack).
  const canonical = input.replace(/^\/jarvis\/agent\/workspace(?=\/|$)/, WORKSPACE_DIR)
  const asked = resolve(isAbsolute(canonical) ? canonical : join(WORKSPACE_DIR, canonical))
  if (!existsSync(asked) || !statSync(asked).isFile()) return { error: `no such file: ${asked}` }
  // Judged on where it really is: a symlink in the workspace must not open
  // the database.
  const path = realpathSync(asked)
  const allowed = within(path, WORKSPACE_DIR)
    || (within(path, REPO_DIR) && !within(path, join(REPO_DIR, 'agent')))
  if (!allowed) return { error: 'path must be under the workspace or the repo (not agent/ outside the workspace)' }
  if (path.split(sep).some((seg) => seg.startsWith('.'))) return { error: 'hidden files cannot be opened' }
  if (!(extOf(path) in DOC_TYPES)) return { error: `cannot show .${extOf(path)} files — supported: ${Object.keys(DOC_TYPES).join(', ')}` }
  if (statSync(path).size > MAX_DOC_BYTES) return { error: 'file too large to show (5 MB max)' }
  return { path }
}

export function listTabs(conversationId: string): TabRow[] {
  return getDb()
    .prepare('SELECT * FROM conversation_tabs WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId) as TabRow[]
}

export function getTab(conversationId: string, tabId: string): TabRow | undefined {
  return getDb()
    .prepare('SELECT * FROM conversation_tabs WHERE id = ? AND conversation_id = ?')
    .get(tabId, conversationId) as TabRow | undefined
}

/** Tell the chat's open screens; `focus` asks them to show that tab. */
export function emitTabs(conversationId: string, focus?: string) {
  emitConversationEvent(conversationId, { type: 'tabs', tabs: listTabs(conversationId), ...(focus ? { focus } : {}) })
}

/**
 * Open a tab, or bring back the one already open on the same target. An
 * unpinned open replaces the chat's temporary tab; a pinned one, or a pin
 * on an existing tab, keeps it for good.
 */
export function openTab(
  conversationId: string,
  input: { kind: 'doc' | 'link'; target: string; title?: string; pinned?: boolean },
): { tab: TabRow } | { error: string } {
  let target = input.target.trim()
  if (input.kind === 'doc') {
    const r = resolveDocPath(target)
    if ('error' in r) return r
    target = r.path
  } else {
    let url: URL
    try { url = new URL(target) } catch { return { error: 'url must be an absolute http(s) URL' } }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'url must be an absolute http(s) URL' }
    target = url.toString()
  }
  const title = input.title?.trim() || defaultTitle(input.kind, target)
  const db = getDb()

  const existing = db
    .prepare('SELECT * FROM conversation_tabs WHERE conversation_id = ? AND kind = ? AND target = ?')
    .get(conversationId, input.kind, target) as TabRow | undefined
  if (existing) {
    db.prepare('UPDATE conversation_tabs SET title = ?, pinned = ? WHERE id = ?')
      .run(input.title?.trim() || existing.title, input.pinned || existing.pinned ? 1 : 0, existing.id)
    return { tab: getTab(conversationId, existing.id)! }
  }

  const id = uuid()
  db.transaction(() => {
    if (!input.pinned) {
      for (const old of db.prepare('SELECT * FROM conversation_tabs WHERE conversation_id = ? AND pinned = 0').all(conversationId) as TabRow[]) {
        closeTab(old)
      }
    }
    db.prepare('INSERT INTO conversation_tabs (id, conversation_id, kind, target, title, pinned) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, conversationId, input.kind, target, title, input.pinned ? 1 : 0)
  })()
  const tab = getTab(conversationId, id)!
  if (tab.kind === 'doc') watchDoc(tab.target)
  return { tab }
}

export function updateTab(tab: TabRow, changes: { pinned?: boolean; title?: string }) {
  if (changes.pinned === undefined && changes.title === undefined) return
  const db = getDb()
  db.transaction(() => {
    // Unpinning makes it the temporary tab: there is only ever one.
    if (changes.pinned === false && tab.pinned) {
      for (const old of db.prepare('SELECT * FROM conversation_tabs WHERE conversation_id = ? AND pinned = 0').all(tab.conversation_id) as TabRow[]) {
        closeTab(old)
      }
    }
    db.prepare('UPDATE conversation_tabs SET pinned = ?, title = ? WHERE id = ?').run(
      changes.pinned === undefined ? tab.pinned : changes.pinned ? 1 : 0,
      changes.title?.trim() || tab.title,
      tab.id,
    )
  })()
}

export function closeTab(tab: TabRow) {
  getDb().prepare('DELETE FROM conversation_tabs WHERE id = ?').run(tab.id)
  if (tab.kind === 'doc') unwatchIfUnused(tab.target)
}

function defaultTitle(kind: 'doc' | 'link', target: string): string {
  if (kind === 'doc') return basename(target)
  try { return new URL(target).hostname.replace(/^www\./, '') } catch { return target }
}

// ── Live documents ──────────────────────────────────────────────────────────
//
// Polled (stat every 1.5 s) rather than inotify: the file is written from
// another container, often by a tool that replaces it through a rename, which
// an fs.watch handle on the old inode never sees.

const watched = new Set<string>()

function watchDoc(path: string) {
  if (watched.has(path)) return
  watched.add(path)
  watchFile(path, { interval: 1500 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
    const tabs = getDb()
      .prepare(`SELECT id, conversation_id FROM conversation_tabs WHERE kind = 'doc' AND target = ?`)
      .all(path) as { id: string; conversation_id: string }[]
    if (!tabs.length) return unwatchIfUnused(path)
    for (const t of tabs) emitConversationEvent(t.conversation_id, { type: 'tab_updated', tab_id: t.id })
  })
}

function unwatchIfUnused(path: string) {
  const used = getDb().prepare(`SELECT 1 FROM conversation_tabs WHERE kind = 'doc' AND target = ? LIMIT 1`).get(path)
  if (used || !watched.has(path)) return
  unwatchFile(path)
  watched.delete(path)
}

/** At boot: watch every document a tab still points at. */
export function watchOpenDocs() {
  const paths = getDb().prepare(`SELECT DISTINCT target FROM conversation_tabs WHERE kind = 'doc'`).all() as { target: string }[]
  for (const { target } of paths) watchDoc(target)
}

const extOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase()

/** What a document tab can show, and how it is served: text for what the pane renders itself. */
const DOC_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
}

export function docContentType(path: string): string {
  return DOC_TYPES[extOf(path)] ?? 'application/octet-stream'
}
