import type { Conversation } from '../api'

type Badged = Pick<Conversation, 'unread_count' | 'app_badge'>

/**
 * The number on a chat: what its app set (`jarvis.setBadge` — an inbox's mail
 * still to deal with) or, without one, its unread replies. The app's count is
 * state rather than news, so it stays while you are in the chat; unread does
 * not (`active`).
 */
export function badgeCount(c: Badged, active = false): number {
  if (c.app_badge && c.app_badge > 0) return c.app_badge
  return active ? 0 : c.unread_count || 0
}

/**
 * The installed app's icon: the sum of every live chat's badge, through the
 * Badging API. Windows, macOS and iOS show the number; Chrome on Android has
 * no such API — there the launcher's dot comes from unread notifications, and
 * this does nothing.
 */
export function syncAppIconBadge(conversations: Record<string, Conversation>): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  if (!nav.setAppBadge) return
  let total = 0
  for (const c of Object.values(conversations)) if (!c.archived_at) total += badgeCount(c)
  if (total === lastTotal) return
  lastTotal = total
  ;(total > 0 ? nav.setAppBadge(total) : nav.clearAppBadge?.())?.catch(() => {})
}
let lastTotal = -1
