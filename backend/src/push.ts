import webpush from 'web-push'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { getDb } from './db.js'
import { config } from './config.js'

const VAPID_PATH = join(dirname(config.dbPath), 'vapid.json')

interface VapidKeys {
  publicKey: string
  privateKey: string
}

let vapidKeys: VapidKeys

export function initPush(): void {
  // Load or generate VAPID keys
  if (existsSync(VAPID_PATH)) {
    vapidKeys = JSON.parse(readFileSync(VAPID_PATH, 'utf-8'))
  } else {
    const keys = webpush.generateVAPIDKeys()
    vapidKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey }
    mkdirSync(dirname(VAPID_PATH), { recursive: true })
    writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2))
    console.log('[push] Generated VAPID keys')
  }

  webpush.setVapidDetails(
    'mailto:' + (config.adminEmail || 'admin@localhost'),
    vapidKeys.publicKey,
    vapidKeys.privateKey,
  )

  // Create push subscriptions table
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT UNIQUE NOT NULL,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `)
}

export function getVapidPublicKey(): string {
  return vapidKeys.publicKey
}

export function saveSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
  getDb()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET keys_p256dh = ?, keys_auth = ?`,
    )
    .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, sub.keys.p256dh, sub.keys.auth)
}

/** Returns how many devices took the push. */
export function sendPushToAll(title: string, body: string, url?: string): Promise<number> {
  return broadcast(JSON.stringify({ title, body, url }))
}

/**
 * A push about one conversation. Stamps `notified_at` first: Today reads it to
 * rank a chat that was worth a notification above one with plain unread
 * answers — and it must be set even if no device takes the push.
 */
export function pushForConversation(conversationId: string, title: string, body: string): Promise<number> {
  getDb().prepare('UPDATE conversations SET notified_at = unixepoch() WHERE id = ?').run(conversationId)
  return sendPushToAll(title, body, `/c/${conversationId}`)
}

// There used to be a "dismiss" push here: reading a chat on one device sent a
// silent push so the others would close their notification. On Android, a push
// that ends with nothing on screen leaves Chrome's own placeholder behind —
// an empty notification that cannot be explained or swiped meaningfully. So a
// notification now stays on a device until that device deals with it: a tap,
// or the app coming to the front there (see frontend/src/lib/notifications.ts).

async function broadcast(payload: string): Promise<number> {
  const subs = getDb()
    .prepare('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions')
    .all() as { endpoint: string; keys_p256dh: string; keys_auth: string }[]

  let delivered = 0
  for (const sub of subs) {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
    }
    try {
      await webpush.sendNotification(pushSub, payload)
      delivered++
    } catch (err: any) {
      const status: number | undefined = err?.statusCode
      const host = (() => { try { return new URL(sub.endpoint).host } catch { return '?' } })()
      // 410/404: the browser dropped the subscription. 403: the push service
      // no longer accepts our VAPID key for it (Apple answers this for a stale
      // or re-registered device). None of them will ever deliver again, so the
      // row goes — the device re-subscribes on its next visit.
      if (status === 410 || status === 404 || status === 403) {
        getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint)
        console.log(`[push] ${host} answered ${status}: subscription removed`)
      } else {
        // The full response body — 'Received unexpected response code' alone
        // said nothing about why.
        console.error(`[push] ${host} failed:`, status ?? err?.message, String(err?.body ?? '').slice(0, 200))
      }
    }
  }
  return delivered
}
