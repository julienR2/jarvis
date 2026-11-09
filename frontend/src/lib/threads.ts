import type { Conversation } from '../api'

/** A picker's "current" for a thread: none of the groups, so every one is a move. */
export const THREAD_GROUP = '__threads__'

/**
 * Filing a thread does more than it looks: it becomes a chat — the routine's
 * chat from then on, which its runs report into from a new thread. Asked
 * once, here, rather than left as a surprise.
 */
export function confirmThreadMove(conv: Conversation | undefined): boolean {
  if (conv?.kind !== 'thread') return true
  return confirm(
    `Move "${conv.title}" into the chats?\n\nIt becomes a regular chat. Its routine will report into it, and run from a new thread from its next run on.`,
  )
}

/** In the sidebar: every chat, and a thread while it is surfaced. */
export function isListed(conv: Conversation): boolean {
  return conv.kind !== 'thread' || !!conv.surfaced_at
}

/**
 * A thread opened to set up a routine that does not exist yet, and never ran
 * one: putting it away throws it away.
 */
export function isDraftThread(conv: Conversation | undefined): boolean {
  return conv?.kind === 'thread' && !conv.thread_of && !conv.has_runs && !conv.parent_message_id
}

// ── A chat's sub-chats ──────────────────────────────────────────────────────

/** A thread untouched this long leaves its chat's active list on its own. */
const STALE_S = 7 * 24 * 3600

/** Opened from a passage (or blank, from the list) — not a routine's thread. */
export const isSubChat = (c: Conversation) => c.kind === 'thread' && !!c.parent_message_id

/** Still in the chat's list: not put away with Done, and moved this week. */
export function isActiveThread(c: Conversation, now = Date.now() / 1000): boolean {
  return !c.archived_at && now - c.updated_at < STALE_S
}

// The threads open as tabs beside each chat, kept per device like the pane
// view: what was left open is still there on return.
const TABS_KEY = 'thread-tabs'
const MAX_CHATS = 200

function loadTabs(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(TABS_KEY) || '{}') as Record<string, string[]>
  } catch {
    return {}
  }
}

export function readThreadTabs(chatId: string): string[] {
  return loadTabs()[chatId] ?? []
}

export function saveThreadTabs(chatId: string, ids: string[]) {
  const all = loadTabs()
  delete all[chatId]
  if (ids.length) all[chatId] = ids
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CHATS))) delete all[k]
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(all))
  } catch {
    /* site data blocked — tabs just won't persist */
  }
}
