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

export async function sendPushToAll(title: string, body: string, url?: string): Promise<void> {
  await broadcast(JSON.stringify({ title, body, url }))
}

/**
 * Tell every device to take down the notifications for one conversation.
 *
 * Reading a chat on the laptop should clear its notification on the phone. The
 * only way to reach another device is a push, so this sends one carrying no
 * title — the service worker recognises `type: 'dismiss'` and closes the
 * matching tag instead of showing anything.
 *
 * Best-effort by nature: a device that is offline gets it whenever it next
 * connects, and one that never does keeps its notification. That is still far
 * better than the pile-up it replaces.
 */
export async function sendDismissToAll(url: string): Promise<void> {
  const sent = await broadcast(JSON.stringify({ type: 'dismiss', url }))
  if (sent) console.log(`[push] dismiss ${url} -> ${sent} device(s)`)
}

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
      // Remove invalid subscriptions (410 Gone, 404)
      if (err.statusCode === 410 || err.statusCode === 404) {
        getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint)
        console.log('[push] Removed stale subscription')
      } else {
        console.error('[push] Failed to send:', err.message)
      }
    }
  }
  return delivered
}
