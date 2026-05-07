import type { FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { config } from '../config.js'

function extractToken(req: any): string | null {
  const qToken = (req.query as any)?.token
  if (qToken) return qToken

  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  const cookie = req.headers.cookie || ''
  const match = cookie.match(/jarvis_ma=([^;]+)/)
  return match ? match[1] : null
}

export async function miniAppRoutes(app: FastifyInstance) {
  // Auth gate — runs before fastify-static serves any file
  app.addHook('onRequest', async (req, reply) => {
    const token = extractToken(req)
    if (!token) return reply.code(404).send('Not found')

    try {
      await app.jwt.verify(token)
    } catch {
      return reply.code(404).send('Not found')
    }

    // Set cookie so sub-resources (CSS, JS, images) are also authenticated
    reply.header(
      'Set-Cookie',
      `jarvis_ma=${token}; HttpOnly; SameSite=Strict; Path=/api/mini-apps; Max-Age=86400`,
    )
  })

  const root = join(config.workspaceDir, 'mini-apps')
  mkdirSync(root, { recursive: true })

  await app.register(fastifyStatic, {
    root,
    decorateReply: false,
  })
}
