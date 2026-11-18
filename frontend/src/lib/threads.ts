import type { Conversation } from '../api'

/** The placeholder title of a conversation opened to set a routine up (backend threads.ts). */
export const ROUTINE_DRAFT_TITLE = 'New routine'

/**
 * A conversation opened to set up a routine that does not exist yet, and
 * never ran one.
 */
export function isDraftThread(conv: Conversation | undefined): boolean {
  return !!conv && conv.title === ROUTINE_DRAFT_TITLE && !conv.thread_of && !conv.has_runs
}

/** The kind of routine that runs in a conversation, if one does. */
export function routineKindOf(conv: Conversation | undefined): 'cron' | 'webhook' | null {
  const of = conv?.thread_of
  return of?.startsWith('cron:') ? 'cron' : of?.startsWith('webhook:') ? 'webhook' : null
}

/**
 * Whether a run's block should say which routine fired it: not in that
 * routine's own conversation, where it would only repeat the title. A run
 * whose row is gone (the list is capped) is taken for the conversation's own.
 */
export function isForeignRun(conv: Conversation | undefined, sourceId: string | null | undefined): boolean {
  const own = conv?.thread_of?.split(':')[1]
  if (!own) return true
  return !!sourceId && sourceId !== own
}

/** `conv` is `ancestorId` itself or sits somewhere under it. */
export function isUnder(conv: Conversation, ancestorId: string, byId: Record<string, Conversation | undefined>): boolean {
  const seen = new Set<string>()
  for (let c: Conversation | undefined = conv; c && !seen.has(c.id); c = c.parent_id ? byId[c.parent_id] : undefined) {
    if (c.id === ancestorId) return true
    seen.add(c.id)
  }
  return false
}

/** Still in its parent's active list: not put away with Done. */
export function isActiveThread(c: Conversation): boolean {
  return !c.archived_at
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
