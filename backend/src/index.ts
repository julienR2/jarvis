import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import bcrypt from 'bcrypt'
import { config } from './config.js'
import { initDb, getDb } from './db.js'
import { authRoutes } from './routes/auth.js'
import {
  conversationRoutes,
  resumeProcessMessage,
} from './routes/conversations.js'
import { sectionRoutes } from './routes/sections.js'
import { cronRoutes } from './routes/crons.js'
import { webhookRoutes, webhookTriggerRoute } from './routes/webhooks.js'
import { uploadRoutes, UPLOADS_DIR, MAX_FILE_SIZE } from './routes/uploads.js'
import { pushRoutes } from './routes/push.js'
import { appRoutes } from './routes/apps.js'
import { internalRoutes } from './routes/internal.js'
import { gitRoutes } from './routes/git.js'
import { connectorRoutes } from './routes/connectors.js'
import { manifestRoutes } from './routes/manifest.js'
import { startCronScheduler } from './crons.js'
import { initPush } from './push.js'
import { subscribeGlobal, addGlobalClient, removeGlobalClient } from './sse.js'
import { listActiveInvocations } from './engine.js'
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

// ── Auth decorator ────────────────────────────────────────────────────────────

app.decorate('authenticate', async function (req: any, reply: any) {
  try {
    await req.jwtVerify()
  } catch {
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

// ── Routes ───────────────────────────────────────────────────────────────────

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(conversationRoutes, { prefix: '/api/conversations' })
await app.register(sectionRoutes, { prefix: '/api/sections' })
await app.register(cronRoutes, { prefix: '/api/crons' })
await app.register(webhookRoutes, { prefix: '/api/webhooks' })
await app.register(webhookTriggerRoute, { prefix: '/api/hooks' })
await app.register(uploadRoutes)
await app.register(pushRoutes, { prefix: '/api/push' })
await app.register(appRoutes, { prefix: '/api/apps' })
await app.register(internalRoutes, { prefix: '/internal' })
await app.register(gitRoutes, { prefix: '/api/git' })
await app.register(connectorRoutes, { prefix: '/api/connectors' })
await app.register(manifestRoutes, { prefix: '/api' })

// ── Global SSE (app-level events) ────────────────────────────────────────────

app.get<{ Querystring: { token?: string } }>('/api/events', async (req, reply) => {
  try {
    await req.jwtVerify()
  } catch {
    const token = req.query.token
    if (!token) return reply.code(401).send({ error: 'Unauthorized' })
    try {
      app.jwt.verify(token)
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' })
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

app.get('/health', async () => ({ ok: true }))

// ── Cron scheduler ────────────────────────────────────────────────────────────

startCronScheduler()

// ── Reconnect to in-flight engine invocations ──────────────────────
//
// If the backend was restarted while Claude was running, the engine
// kept the process alive and buffered its events. Re-subscribe so we finish
// persisting the conversation to the DB and let the frontend see the result.

async function reconnectActiveSessions(): Promise<void> {
  try {
    const invocations = await listActiveInvocations()
    const running = invocations.filter((inv) => inv.status === 'running')
    if (running.length === 0) return

    console.log(
      `[reconnect] found ${running.length} running invocation(s) to resume`,
    )
    for (const inv of running) {
      const conv = getDb()
        .prepare('SELECT * FROM conversations WHERE id = ?')
        .get(inv.conversationId) as ConvRow | undefined
      if (!conv) {
        console.warn(
          `[reconnect] conversation ${inv.conversationId} not found, skipping invocation ${inv.id}`,
        )
        continue
      }
      console.log(
        `[reconnect] resuming invocation ${inv.id} for conversation ${inv.conversationId}`,
      )
      resumeProcessMessage(inv.id, inv.conversationId, conv)
    }
  } catch (err) {
    console.error('[reconnect] failed:', err)
  }
}

// Fire off reconnection without blocking startup — the engine may
// still be booting when the backend comes up.
reconnectActiveSessions()

// ── Start ────────────────────────────────────────────────────────────────────

await app.listen({ port: config.port, host: '0.0.0.0' })
console.log(`Jarvis backend running on :${config.port}`)
