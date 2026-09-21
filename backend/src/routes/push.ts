import type { FastifyInstance } from 'fastify'
import { getVapidPublicKey, saveSubscription, sendPushToAll } from '../push.js'

export function pushRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  // Get VAPID public key (needed by frontend to subscribe)
  app.get('/vapid-key', { preHandler: [app.authenticate] }, async () => {
    return { key: getVapidPublicKey() }
  })

  // Save a push subscription
  app.post('/subscribe', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { subscription } = req.body as { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return reply.code(400).send({ error: 'Invalid subscription' })
    }
    saveSubscription(subscription)
    return { ok: true }
  })

  // A push to every registered device, so a person can tell from Settings
  // whether this phone or that laptop actually hears Jarvis. Also prunes the
  // subscriptions the push services no longer accept (see broadcast()).
  app.post('/test', { preHandler: [app.authenticate] }, async () => {
    const delivered = await sendPushToAll('Jarvis', 'Test notification — this device hears Jarvis.', '/')
    return { delivered }
  })

  done()
}
