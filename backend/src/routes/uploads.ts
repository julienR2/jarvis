import type { FastifyInstance } from 'fastify'
import type { MultipartFile } from '@fastify/multipart'
import { randomUUID } from 'crypto'
import { mkdirSync, createWriteStream } from 'fs'
import { join, extname } from 'path'
import { pipeline } from 'stream/promises'
import { config } from '../config.js'

const UPLOADS_DIR = join(config.workspaceDir, 'uploads')
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB

// Ensure uploads directory exists (needed before @fastify/static registers)
try { mkdirSync(UPLOADS_DIR, { recursive: true }) } catch { /* may fail outside Docker */ }

export function uploadRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {

  // Upload a file
  app.post('/api/uploads', { preHandler: [app.authenticate] }, async (req, reply) => {
    const file: MultipartFile | undefined = await (req as any).file()
    if (!file) {
      return reply.code(400).send({ error: 'No file provided' })
    }

    const ext = extname(file.filename) || ''
    const id = randomUUID()
    const storedName = `${id}${ext}`
    const filePath = join(UPLOADS_DIR, storedName)

    await pipeline(file.file, createWriteStream(filePath))

    // Check if the stream was truncated (file too large)
    if (file.file.truncated) {
      // Clean up
      const { unlink } = await import('fs/promises')
      await unlink(filePath).catch(() => {})
      return reply.code(413).send({ error: 'File too large (max 20MB)' })
    }

    return {
      id,
      filename: storedName,
      originalName: file.filename,
      mimetype: file.mimetype,
      size: file.file.bytesRead,
      url: `/api/uploads/files/${storedName}`,
      // Path accessible by Claude inside the container
      path: `/jarvis/workspace/uploads/${storedName}`,
    }
  })

  done()
}

export { UPLOADS_DIR, MAX_FILE_SIZE }
