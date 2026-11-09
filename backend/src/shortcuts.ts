import { getDb } from './db.js'

/**
 * Chats offered as launcher shortcuts of the installed app — the list a
 * long-press on the Jarvis icon shows on Android, from which one can be
 * dragged onto the home screen as an icon of its own.
 *
 * Capped, and the cap is enforced when one is added rather than by trimming
 * the manifest: launchers show about four, and a fifth silently missing from
 * the list would leave no way to tell which chats made it.
 */
export const MAX_SHORTCUTS = 4

export interface ShortcutRow {
  id: string
  title: string
}

/** In the order they were added — the order the manifest lists them in. */
export function listShortcuts(): ShortcutRow[] {
  return getDb()
    .prepare(
      `SELECT id, title FROM conversations
        WHERE shortcut_at IS NOT NULL
        ORDER BY shortcut_at, rowid
        LIMIT ?`,
    )
    .all(MAX_SHORTCUTS) as ShortcutRow[]
}
