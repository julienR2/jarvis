/**
 * Which panes a chat with an app shows — the chat, the app, or both side by
 * side (desktop only) — remembered per chat.
 *
 * Per-device, so localStorage rather than the DB: a phone has room for one
 * pane and a desktop for two, and what suits a chat on one says little about
 * the other. A chat with nothing saved shows the default (the app on mobile,
 * both on desktop).
 */
export type PaneView = 'chat' | 'app' | 'both'

const STORAGE_KEY = 'pane-views'
/** Oldest choices are dropped past this, so deleted chats don't pile up. */
const MAX_SAVED = 200

function load(): Record<string, PaneView> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, PaneView>
  } catch {
    return {}
  }
}

export function readPaneView(conversationId: string): PaneView | undefined {
  return load()[conversationId]
}

export function savePaneView(conversationId: string, view: PaneView) {
  const saved = load()
  // Re-inserted so the key order is least- to most-recently chosen.
  delete saved[conversationId]
  saved[conversationId] = view
  const keys = Object.keys(saved)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SAVED))) delete saved[key]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    /* private window, or site data blocked — the choice lasts until reload */
  }
}
