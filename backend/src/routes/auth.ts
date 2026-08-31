import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'
import { readFileSync, writeFileSync } from 'fs'
import { getDb } from '../db.js'
import { config } from '../config.js'
import type { UserRow } from '../types.js'

const SECRETS_PATH = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'

function readSecrets(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeSecrets(secrets: Record<string, unknown>): void {
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 })
}

export async function authRoutes(app: FastifyInstance) {
  // GET /setup-status — public: lets the UI decide between login and first-run setup
  app.get('/setup-status', async () => {
    const row = getDb().prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
    const secrets = readSecrets()
    const hasToken = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || secrets.claudeOauthToken)
    return { needsSetup: row.n === 0, hasToken }
  })

  // POST /setup — public, but only works when zero users exist
  app.post('/setup', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string }

    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password required' })
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' })
    }

    const { n } = getDb().prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
    if (n > 0) {
      return reply.code(403).send({ error: 'Setup already complete' })
    }

    const hash = await bcrypt.hash(password, 10)
    const result = getDb()
      .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .run(email, hash)

    const token = app.jwt.sign(
      { id: result.lastInsertRowid, email },
      { expiresIn: config.jwtExpiresIn },
    )
    return { token }
  })

  app.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string }

    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password required' })
    }

    const user = getDb()
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as UserRow | undefined

    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    const token = app.jwt.sign(
      { id: user.id, email: user.email },
      { expiresIn: config.jwtExpiresIn },
    )
    return { token }
  })

  app.get('/me', { onRequest: [app.authenticate] }, async (req) => {
    const user = req.user as { id: number; email: string }
    const row = getDb().prepare('SELECT onboarded FROM users WHERE id = ?').get(user.id) as { onboarded: number } | undefined
    return { ...user, onboarded: !!(row?.onboarded) }
  })

  // POST /complete-onboarding — mark the current user as onboarded
  app.post('/complete-onboarding', { onRequest: [app.authenticate] }, async (req) => {
    const user = req.user as { id: number }
    getDb().prepare('UPDATE users SET onboarded = 1 WHERE id = ?').run(user.id)
    return { ok: true }
  })

  // POST /setup-token — save the Claude Code OAuth token
  app.post('/setup-token', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { token } = req.body as { token?: string }
    if (!token || !token.trim()) {
      return reply.code(400).send({ error: 'Token is required' })
    }

    const trimmed = token.trim()

    // Persist to secrets.json — the durable store (bind-mounted, survives
    // rebuilds), read fresh by the engine on every claude spawn. The .env
    // file is operator/infra territory; the app never writes to it.
    const secrets = readSecrets()
    secrets.claudeOauthToken = trimmed
    writeSecrets(secrets)

    return { ok: true }
  })
}
