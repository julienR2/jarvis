import type { FastifyInstance } from 'fastify'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, relative, normalize } from 'path'
import { config } from '../config.js'

// Browse both workspace and claude config directories
const BROWSE_ROOTS: Record<string, string> = {
  workspace: config.workspaceDir,
  claude: config.claudeConfigDir,
}

function safePath(inputPath: string): string | null {
  const topDir = inputPath.split('/')[0]
  const root = BROWSE_ROOTS[topDir]
  if (!root) return null

  const subPath = inputPath.slice(topDir.length + 1) || ''
  const normalized = normalize(join(root, subPath))

  // Prevent path traversal
  if (!normalized.startsWith(root)) return null

  return normalized
}

export async function fileRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  // List files in a directory
  app.get<{ Querystring: { path?: string } }>('/', auth, async (req, reply) => {
    const inputPath = req.query.path || ''

    if (!inputPath) {
      // Return the top-level browseable roots
      return Object.entries(BROWSE_ROOTS).map(([name, root]) => {
        try {
          const stat = statSync(root)
          return { name, path: name, type: 'dir' as const, size: 0, modified: stat.mtimeMs }
        } catch {
          return { name, path: name, type: 'dir' as const, size: 0, modified: 0 }
        }
      })
    }

    const target = safePath(inputPath)
    if (!target) {
      return reply.code(403).send({ error: 'Access denied' })
    }

    try {
      const stat = statSync(target)
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'Not a directory' })
      }

      const topDir = inputPath.split('/')[0]
      const root = BROWSE_ROOTS[topDir]!

      return readdirSync(target).map((name) => {
        const full = join(target, name)
        const s = statSync(full)
        const rel = topDir + '/' + relative(root, full)
        return {
          name,
          path: rel,
          type: s.isDirectory() ? ('dir' as const) : ('file' as const),
          size: s.isFile() ? s.size : 0,
          modified: s.mtimeMs,
        }
      })
    } catch {
      return reply.code(404).send({ error: 'Directory not found' })
    }
  })

  // Read a file
  app.get<{ Querystring: { path: string } }>('/content', auth, async (req, reply) => {
    const target = safePath(req.query.path)
    if (!target) return reply.code(403).send({ error: 'Access denied' })

    try {
      const content = readFileSync(target, 'utf8')
      return { content }
    } catch {
      return reply.code(404).send({ error: 'File not found' })
    }
  })

  // Write a file
  app.put<{ Querystring: { path: string } }>('/content', auth, async (req, reply) => {
    const target = safePath(req.query.path)
    if (!target) return reply.code(403).send({ error: 'Access denied' })

    const { content } = req.body as { content: string }
    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'content must be a string' })
    }

    try {
      writeFileSync(target, content, 'utf8')
      return { ok: true }
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })
}
