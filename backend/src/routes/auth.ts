import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'
import { getDb } from '../db.js'
import { config } from '../config.js'
import type { UserRow } from '../types.js'

export async function authRoutes(app: FastifyInstance) {
  // GET /setup-status — public: lets the UI decide between login and first-run setup
  app.get('/setup-status', async () => {
    const row = getDb().prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
    return { needsSetup: row.n === 0 }
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
    return req.user
  })
}
