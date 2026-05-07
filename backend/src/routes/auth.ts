import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'
import { getDb } from '../db.js'
import type { UserRow } from '../types.js'

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req, reply) => {
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

    const token = app.jwt.sign({ id: user.id, email: user.email })
    return { token }
  })

  app.get('/me', { onRequest: [app.authenticate] }, async (req) => {
    return req.user
  })
}
