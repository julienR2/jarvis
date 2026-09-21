/**
 * This device's own notifications, closed from the page.
 *
 * A notification used to be taken down on every device by a silent push when
 * the chat was read anywhere. On Android that push left Chrome's empty
 * placeholder behind, so it is gone: a notification now lives until this
 * device deals with it. Two moments count as dealing with it here — opening
 * the chat it points to, and bringing the app to the front with the chat
 * already read elsewhere.
 *
 * Tags come from the service worker: `jarvis-<url>`, url being `/c/<id>`.
 */
const tagFor = (conversationId: string) => `jarvis-/c/${conversationId}`

async function shown(): Promise<Notification[]> {
  try {
    if (!('serviceWorker' in navigator) || !('Notification' in window)) return []
    const reg = await navigator.serviceWorker.getRegistration()
    return reg ? await reg.getNotifications() : []
  } catch {
    return []
  }
}

/** The chat is on screen: its notification has nothing left to say. */
export async function closeNotificationsFor(conversationId: string): Promise<void> {
  const tag = tagFor(conversationId)
  for (const n of await shown()) if (n.tag === tag) n.close()
}

/**
 * Back in front: close the notifications of chats that are read (or gone),
 * keep the ones that still have something unread behind them.
 */
export async function closeNotificationsOfRead(
  conversations: Record<string, { unread_count?: number }>,
): Promise<void> {
  for (const n of await shown()) {
    const id = n.tag?.startsWith('jarvis-/c/') ? n.tag.slice('jarvis-/c/'.length) : null
    if (!id) continue
    const conv = conversations[id]
    if (!conv || !conv.unread_count) n.close()
  }
}
