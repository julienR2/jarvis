import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import bcrypt from 'bcrypt'
import { config } from './config.js'
import { extractRequestToken, applyApiKey, verifySession } from './request-auth.js'
import { resolveShareToken } from './share-access.js'
import { userForApiKey } from './api-keys.js'
import { initDb, getDb } from './db.js'
import { authRoutes } from './routes/auth.js'
import {
  conversationRoutes,
  resumeProcessMessage,
} from './routes/conversations.js'
import { sectionRoutes } from './routes/sections.js'
import { cronRoutes } from './routes/crons.js'
import { runRoutes } from './routes/runs.js'
import { runByKey, reconcileStaleRuns } from './runs.js'
import { seedFixtures } from './fixtures.js'
import { webhookRoutes, webhookTriggerRoute } from './routes/webhooks.js'
import { uploadRoutes, UPLOADS_DIR, MAX_FILE_SIZE } from './routes/uploads.js'
import { pushRoutes } from './routes/push.js'
import { appRoutes } from './routes/apps.js'
import { internalRoutes } from './routes/internal.js'
import { gitRoutes } from './routes/git.js'
import { connectorRoutes } from './routes/connectors.js'
import { pluginRoutes } from './routes/plugins.js'
import { manifestRoutes } from './routes/manifest.js'
import { sharedRoutes } from './routes/shared.js'
import { browserRoutes } from './routes/browser.js'
import { modelRoutes } from './routes/models.js'
import { apiKeyRoutes } from './routes/api-keys.js'
import { startCronScheduler } from './crons.js'
import { startFrontendWatch } from './frontend-watch.js'
import { initPush } from './push.js'
import { subscribeGlobal, addGlobalClient, removeGlobalClient } from './sse.js'
import { listBusyConversations } from './engine.js'
import type { ConvRow } from './types.js'

// ── Fastify type augmentation ────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: any, reply: any) => Promise<void>
  }
}

// ── App ──────────────────────────────────────────────────────────────────────

const app = Fastify({
  logger: { level: 'info' },
  bodyLimit: 1 * 1024 * 1024, // 1MB — multipart uploads use their own larger limit
  // Without this, every request behind the reverse proxy shares the proxy's IP
  // and one abusive client rate-limits everybody (e.g. locks all users out of
  // login). See config.trustProxy for the TRUST_PROXY env contract.
  trustProxy: config.trustProxy,
})

// ── Plugins ──────────────────────────────────────────────────────────────────

await app.register(helmet, {
  contentSecurityPolicy: false,      // frontend is a separate origin; CSP belongs there
  crossOriginResourcePolicy: false,  // lets frontend on :5173 load /api/uploads assets
  crossOriginEmbedderPolicy: false,  // allow app iframes
})
await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: '1 minute',
  // Exempt static asset routes: apps can serve hundreds of images (grids,
  // map tiles) that would otherwise blow past the API limit. These are
  // auth-gated static file serves, cheap and safe to leave unthrottled.
  allowList: (req) =>
    req.url === '/health' ||
    req.url.startsWith('/api/apps/') ||
    req.url.startsWith('/api/uploads/'),
})
await app.register(cors, { origin: true })
await app.register(jwt, { secret: config.jwtSecret })
await app.register(multipart, { limits: { fileSize: MAX_FILE_SIZE } })
await app.register(fastifyStatic, {
  root: UPLOADS_DIR,
  prefix: '/api/uploads/files/',
  decorateReply: false,
})

// Uploaded and agent-generated files were served to anyone who knew the path.
// UUID filenames are obscurity, not access control, and the paths leak through
// app frames, Referer headers and logs. Gate them like everything else — via
// the session cookie or ?token=, since <img>/<a> can't set a header.
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/uploads/files/')) return
  const token = extractRequestToken(req)
  if (!token) return reply.code(404).send({ error: 'Not found' })

  try {
    await app.jwt.verify(token)
    return
  } catch {
    /* not a session — an API key or a share link may still own this file */
  }

  if (userForApiKey(token)) return

  // Uploads are stored under the conversation they belong to, so a share link
  // can serve its own conversation's images without opening the whole store.
  // Without this a shared chat would render every attachment as a broken image.
  const share = resolveShareToken(token)
  if (!share) return reply.code(404).send({ error: 'Not found' })

  const rest = req.url.slice('/api/uploads/files/'.length).split('?')[0]
  const segments = rest.split('/').filter(Boolean).map((x) => {
    try { return decodeURIComponent(x) } catch { return x }
  })

  if (segments.length > 1) {
    if (segments[0] !== share.conv.id) {
      return reply.code(404).send({ error: 'Not found' })
    }
    return
  }

  // Files predating per-conversation folders sit flat in the uploads root, so
  // the path says nothing about who owns them. Fall back to asking whether this
  // conversation actually references the file — otherwise sharing an older
  // conversation would render every one of its images broken.
  const file = segments[0]
  if (!file) return reply.code(404).send({ error: 'Not found' })
  const referenced = getDb()
    .prepare(
      `SELECT 1 FROM messages
        WHERE conversation_id = ? AND metadata LIKE ? LIMIT 1`,
    )
    .get(share.conv.id, `%${file}%`)
  if (!referenced) return reply.code(404).send({ error: 'Not found' })
})

// ── Auth decorator ────────────────────────────────────────────────────────────

// A session JWT and an API key are the same account arriving by different
// doors, so both are resolved here rather than on a separate set of routes:
// whatever the UI can call, a key can call, with no second surface to keep in
// step. Handlers read `req.user` and never learn which door was used.
app.decorate('authenticate', async function (req: any, reply: any) {
  try {
    await verifySession(req)
    req.user.via = 'session'
    return
  } catch {
    /* not a session — an API key may still authenticate this */
  }
  if (!applyApiKey(req, extractRequestToken(req))) {
    reply.code(401).send({ error: 'Unauthorized' })
  }
})

// ── DB init + seed admin user ─────────────────────────────────────────────────

initDb()
initPush()

if (config.adminEmail && config.adminPassword) {
  const existing = getDb()
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(config.adminEmail)

  if (!existing) {
    const hash = await bcrypt.hash(config.adminPassword, 10)
    getDb()
      .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .run(config.adminEmail, hash)
    console.log(`[init] Created admin user: ${config.adminEmail}`)
  }
}

// Throwaway instances (the next stack, e2e) start with something to look at.
if (process.env.SEED_FIXTURES === '1') seedFixtures()

// ── Routes ───────────────────────────────────────────────────────────────────

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(conversationRoutes, { prefix: '/api/conversations' })
await app.register(sectionRoutes, { prefix: '/api/sections' })
await app.register(cronRoutes, { prefix: '/api/crons' })
await app.register(runRoutes, { prefix: '/api/runs' })
await app.register(webhookRoutes, { prefix: '/api/webhooks' })
await app.register(webhookTriggerRoute, { prefix: '/api/hooks' })
await app.register(uploadRoutes)
await app.register(pushRoutes, { prefix: '/api/push' })
await app.register(appRoutes, { prefix: '/api/apps' })
await app.register(internalRoutes, { prefix: '/internal' })
await app.register(gitRoutes, { prefix: '/api/git' })
await app.register(connectorRoutes, { prefix: '/api/connectors' })
await app.register(pluginRoutes, { prefix: '/api/plugins' })
await app.register(manifestRoutes, { prefix: '/api' })
await app.register(sharedRoutes, { prefix: '/api/shared' })
await app.register(browserRoutes)
await app.register(modelRoutes)
await app.register(apiKeyRoutes, { prefix: '/api/api-keys' })

// ── Global SSE (app-level events) ────────────────────────────────────────────

app.get<{ Querystring: { token?: string } }>('/api/events', async (req, reply) => {
  try {
    await verifySession(req)
  } catch {
    // EventSource can't set headers, so the credential rides in the query —
    // either flavour, since a script watching the stream has a key, not a JWT.
    const token = req.query.token ?? extractRequestToken(req)
    if (!token) return reply.code(401).send({ error: 'Unauthorized' })
    if (!userForApiKey(token)) {
      try {
        app.jwt.verify(token)
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
    }
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  reply.raw.write('\n')
  reply.hijack()
  addGlobalClient()

  const unsubscribe = subscribeGlobal((data) => {
    reply.raw.write(`data: ${data}\n\n`)
  })

  const heartbeat = setInterval(() => {
    reply.raw.write(': heartbeat\n\n')
  }, 30000)

  req.raw.on('close', () => {
    unsubscribe()
    clearInterval(heartbeat)
    removeGlobalClient()
  })
})

// ── Health check ──────────────────────────────────────────────────────────────

// uptime lets a deploy prove the restart it asked for actually happened.
app.get('/health', async () => ({ ok: true, uptime: Math.round(process.uptime()) }))

// ── Cron scheduler ────────────────────────────────────────────────────────────

startCronScheduler()

// ── Frontend build watcher ────────────────────────────────────────────────────
// Tells open tabs when Jarvis has rebuilt its own UI, so a self-edit doesn't sit
// invisible behind a stale bundle.

startFrontendWatch()

// ── Reconnect to in-flight engine invocations ──────────────────────
//
// If the backend was restarted while Claude was running, the engine
// kept the process alive and buffered its events. Re-subscribe so we finish
// persisting the conversation to the DB and let the frontend see the result.

async function reconnectActiveSessions(): Promise<void> {
  try {
    const busy = await listBusyConversations()
    if (busy.length === 0) return

    console.log(
      `[reconnect] found ${busy.length} busy conversation(s) to resume`,
    )
    for (const conversationId of busy) {
      // An isolated run's engine key is not a conversation id, so look it up
      // as a run first. This is the runKey->conversation mapping the comment
      // here used to say we didn't keep: the `runs` table now holds it, so a
      // restart mid-cron no longer throws the run's output away.
      const run = runByKey(conversationId)
      const targetId = run?.conversation_id ?? conversationId

      const conv = getDb()
        .prepare('SELECT * FROM conversations WHERE id = ?')
        .get(targetId) as ConvRow | undefined
      if (!conv) {
        // Genuinely synthetic ids land here: title generation and probes.
        console.warn(
          `[reconnect] conversation ${conversationId} not found, skipping`,
        )
        continue
      }
      if (run) {
        console.log(
          `[reconnect] resuming ${run.kind} run "${run.source_name}" into ${targetId}`,
        )
        resumeProcessMessage(targetId, conv, {
          runKey: run.run_key ?? undefined,
          runId: run.id,
        })
        continue
      }
      console.log(`[reconnect] resuming conversation ${conversationId}`)
      resumeProcessMessage(conversationId, conv)
    }
  } catch (err) {
    console.error('[reconnect] failed:', err)
  }
}

// Fire off reconnection without blocking startup — the engine may
// still be booting when the backend comes up. Whatever it could not re-attach
// to is gone with the old process, so close those runs out rather than leave
// them showing a Stop button for a session nothing is listening to.
reconnectActiveSessions().then(reconcileStaleRuns)

// ── Start ────────────────────────────────────────────────────────────────────

await app.listen({ port: config.port, host: '0.0.0.0' })
console.log(`Jarvis backend running on :${config.port}`)
