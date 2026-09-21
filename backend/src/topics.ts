// Topics — a section with a shared context.
//
// A section used to be a sidebar group and nothing more. A topic is the same
// row carrying a brief: what this is about, what was decided, what is still
// open, the facts and tools that matter here. Every chat filed under the topic
// starts from that brief, and every routine posting into one of its chats runs
// with it — so the context is built once and shared, instead of re-explained
// at the top of each new conversation.
//
// Two mechanisms, both here:
//   - injection: the brief goes into the prompt of a chat's first turn, and
//     again whenever it has been rewritten since (topicContextFor);
//   - consolidation: Jarvis rewrites the brief from the topic's recent chats,
//     on request or on a routine's schedule (startConsolidation), and writes it
//     back through the internal API the `topic` skill documents.

import { getDb, uuid } from './db.js'
import { config } from './config.js'
import { emitGlobalEvent } from './sse.js'
import type { ConvRow, SectionRow } from './types.js'

/** Longer than this and the brief is a document, not a brief. */
export const MAX_CONTEXT_CHARS = 8000

export function getSection(id: string): SectionRow | undefined {
  return getDb().prepare('SELECT * FROM sections WHERE id = ?').get(id) as SectionRow | undefined
}

/**
 * Rewrite a topic's context. Stamps `context_updated_at` so chats whose
 * session already holds the old text get the new one on their next turn, and
 * nudges every open screen (the topic page, the sidebar) to refetch.
 */
export function setSectionContext(id: string, context: string): SectionRow | undefined {
  const clean = context.replace(/\r\n/g, '\n').trim().slice(0, MAX_CONTEXT_CHARS)
  const result = getDb()
    .prepare('UPDATE sections SET context = ?, context_updated_at = unixepoch() WHERE id = ?')
    .run(clean, id)
  if (result.changes === 0) return undefined
  emitGlobalEvent({ type: 'sections' })
  return getSection(id)
}

/**
 * The topic brief to put in front of this turn's prompt, or null when the
 * session already has it.
 *
 * "Already has it" is judged from what the session can remember: a fresh
 * session (no id yet, or an isolated run's throwaway one) has nothing, and a
 * warm one has whatever was injected before the brief was last rewritten.
 * The stamp is written here, on the same tick as the decision, so two turns
 * sent back to back don't both carry it.
 */
export function topicContextFor(conv: ConvRow, opts: { freshSession?: boolean } = {}): string | null {
  if (!conv.section_id) return null
  const section = getSection(conv.section_id)
  if (!section || !section.context.trim() || section.brief_hidden) return null
  const fresh = opts.freshSession || !conv.claude_session_id
  const rewritten = (section.context_updated_at ?? 0) > (conv.topic_context_at ?? 0)
  if (!fresh && !rewritten) return null
  getDb()
    .prepare('UPDATE conversations SET topic_context_at = unixepoch() WHERE id = ?')
    .run(conv.id)
  return [
    '<article data-jarvis="topic-context">',
    `This chat is filed under the topic "${section.name}". Its shared brief, kept across every chat of the topic:`,
    '',
    section.context.trim(),
    '',
    'When something durable is decided or learned here, update the brief with the `topic` skill so the other chats of this topic know too. Do not repeat the brief back to the person.',
    '</article>',
  ].join('\n')
}

/** The conversations filed under a topic, most recent first. */
export function topicConversations(sectionId: string): Pick<ConvRow, 'id' | 'title' | 'updated_at'>[] {
  return getDb()
    .prepare('SELECT id, title, updated_at FROM conversations WHERE section_id = ? ORDER BY updated_at DESC')
    .all(sectionId) as Pick<ConvRow, 'id' | 'title' | 'updated_at'>[]
}

/**
 * The chat consolidation runs in: one per topic, reused, so the history of
 * rewrites reads in one place. Created on first use, filed under the topic —
 * it is a chat like any other, and the person can talk to it.
 */
export function ensureDossierConversation(section: SectionRow): ConvRow {
  const title = `${section.name} · dossier`
  const existing = getDb()
    .prepare('SELECT * FROM conversations WHERE section_id = ? AND title = ?')
    .get(section.id, title) as ConvRow | undefined
  if (existing) return existing
  const id = uuid()
  getDb()
    .prepare(
      `INSERT INTO conversations (id, title, model, effort, section_id, last_read_at, notify)
       VALUES (?, ?, NULL, 'high', ?, unixepoch(), 'unsubscribe')`,
    )
    .run(id, title, section.id)
  return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConvRow
}

/**
 * The prompt that rewrites a topic's brief. The `topic` skill has the same
 * instructions; they are repeated here because a consolidation is fired from a
 * button or a routine, with no person in the loop to point at the skill.
 */
export function consolidationPrompt(section: SectionRow, exclude?: string): string {
  const chats = topicConversations(section.id)
    .filter((c) => c.id !== exclude)
    .slice(0, 12)
    .map((c) => `- ${c.title} — id ${c.id} — last active ${new Date(c.updated_at * 1000).toISOString().slice(0, 10)}`)
  return [
    `Consolidate the shared brief of the topic "${section.name}".`,
    '',
    'The brief is what every chat filed under this topic starts from, so it must be short, current and factual.',
    '',
    '## Current brief',
    section.context.trim() || '(empty)',
    '',
    '## Chats in this topic, most recent first',
    chats.length ? chats.join('\n') : '(none yet)',
    '',
    'Read the recent ones — the last few weeks, or whatever the brief does not cover yet:',
    '```bash',
    `curl -s -H "X-Internal-Secret: $INTERNAL_SECRET" "${config.internalUrl}/internal/conversations/<id>/messages?limit=40"`,
    '```',
    '',
    '## What to write',
    'Markdown, under 2000 characters, no chatter. Sections, each only if it has content:',
    '- **What this is** — two or three lines.',
    '- **Decided** — settled points, with dates or amounts when they matter.',
    '- **Open** — what is still pending, who is waited on.',
    '- **Facts** — names, numbers, addresses, ids worth having at hand.',
    '- **How to work here** — the skills, connectors, files or conventions that apply.',
    'Drop what is done or stale. Keep what a new chat would otherwise have to be told.',
    '',
    '## Save it',
    '```bash',
    `curl -s -X PATCH "${config.internalUrl}/internal/topics/${section.id}/context" \\`,
    '  -H "X-Internal-Secret: $INTERNAL_SECRET" -H "Content-Type: application/json" \\',
    "  -d \"$(python3 -c 'import json,sys;print(json.dumps({\"context\": open(sys.argv[1]).read()}))' brief.md)\"",
    '```',
    '',
    'Then reply in three or four lines with what changed in the brief. Nothing else.',
  ].join('\n')
}
