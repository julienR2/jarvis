import type { FastifyInstance } from 'fastify'
import { join, extname, sep } from 'path'
import { mkdirSync, createReadStream, statSync } from 'fs'
import { config } from '../config.js'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

function extractToken(req: any): string | null {
  const qToken = (req.query as any)?.token
  if (qToken) return qToken

  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  const cookie = req.headers.cookie || ''
  const match = cookie.match(/jarvis_app=([^;]+)/)
  return match ? match[1] : null
}

export async function appRoutes(app: FastifyInstance) {
  const root = join(config.workspaceDir, 'apps')
  mkdirSync(root, { recursive: true })

  app.get('/*', async (req, reply) => {
    const token = extractToken(req)
    if (!token) return reply.code(404).send('Not found')

    try {
      await app.jwt.verify(token)
    } catch {
      return reply.code(404).send('Not found')
    }

    reply.header(
      'Set-Cookie',
      `jarvis_app=${token}; HttpOnly; SameSite=Strict; Path=/api/apps; Max-Age=86400`,
    )

    const urlPath = (req.params as any)['*'] as string
    const slashIdx = urlPath.indexOf('/')
    const slug = slashIdx > 0 ? urlPath.slice(0, slashIdx) : urlPath
    const filePath = slashIdx > 0 ? urlPath.slice(slashIdx + 1) : 'index.html'

    const fullPath = join(root, slug, filePath || 'index.html')

    // Prevent path traversal. The trailing separator matters: without it a
    // slug of ".." satisfies startsWith(root) via sibling dirs like apps-archive.
    if (!fullPath.startsWith(root + sep)) {
      return reply.code(404).send('Not found')
    }

    try {
      const stat = statSync(fullPath)
      if (!stat.isFile()) return reply.code(404).send('Not found')
    } catch {
      return reply.code(404).send('Not found')
    }

    const mime = MIME[extname(fullPath).toLowerCase()] || 'application/octet-stream'
    reply.type(mime)
    return reply.send(createReadStream(fullPath))
  })
}
