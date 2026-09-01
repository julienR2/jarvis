import type { FastifyInstance } from 'fastify'
import type { MultipartFile } from '@fastify/multipart'
import { randomUUID } from 'crypto'
import { mkdirSync, createWriteStream } from 'fs'
import { join, extname } from 'path'
import { pipeline } from 'stream/promises'
import { config } from '../config.js'

const UPLOADS_DIR = join(config.workspaceDir, 'uploads')
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB

// Conversation ids are uuids. Validated before being used as a directory name so
// a crafted `?conversationId=../..` can't write outside the uploads tree.
const CONV_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Ensure uploads directory exists (needed before @fastify/static registers)
try { mkdirSync(UPLOADS_DIR, { recursive: true }) } catch { /* may fail outside Docker */ }

export function uploadRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {

  // Upload a file
  //
  // Files land in `uploads/<conversationId>/` when the caller says which
  // conversation they belong to, so a conversation's files can be archived or
  // purged with it. Callers that don't pass an id (and everything uploaded
  // before this existed) sit flat at the root of `uploads/`.
  app.post<{ Querystring: { conversationId?: string } }>('/api/uploads', { preHandler: [app.authenticate] }, async (req, reply) => {
    const file: MultipartFile | undefined = await (req as any).file()
    if (!file) {
      return reply.code(400).send({ error: 'No file provided' })
    }

    const convId = req.query.conversationId
    const subdir = convId && CONV_ID_RE.test(convId) ? convId : ''

    const ext = extname(file.filename) || ''
    const id = randomUUID()
    // Relative to UPLOADS_DIR — this is the identity used in the url and stored
    // on the message, so it must carry the subdirectory when there is one.
    const relName = subdir ? `${subdir}/${id}${ext}` : `${id}${ext}`
    const filePath = join(UPLOADS_DIR, relName)

    if (subdir) mkdirSync(join(UPLOADS_DIR, subdir), { recursive: true })

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
      filename: relName,
      originalName: file.filename,
      mimetype: file.mimetype,
      size: file.file.bytesRead,
      url: `/api/uploads/files/${relName}`,
      // Path accessible by Claude inside the container
      path: filePath,
    }
  })

  done()
}

export { UPLOADS_DIR, MAX_FILE_SIZE }
