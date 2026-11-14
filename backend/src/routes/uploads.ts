import type { FastifyInstance } from 'fastify'
import type { MultipartFile } from '@fastify/multipart'
import { randomUUID } from 'crypto'
import { mkdirSync, createWriteStream, renameSync, cpSync, rmSync, existsSync } from 'fs'
import { join, extname, dirname, basename, resolve, sep } from 'path'
import { pipeline } from 'stream/promises'
import { config } from '../config.js'
import { isPrivateConversation } from '../private.js'

const UPLOADS_DIR = join(config.workspaceDir, 'uploads')

/**
 * Where a private conversation's files live (see private.ts): beside the
 * database in `agent/data/`, which the engine container sees as an empty tmpfs.
 * In `uploads/` the agent could read them from any other chat with a shell
 * command, and the content would go to Anthropic with the next turn.
 */
const PRIVATE_UPLOADS_DIR = join(dirname(config.dbPath), 'private-uploads')
const PRIVATE_URL_PREFIX = '/api/uploads/private/'
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB

// Conversation ids are uuids. Validated before being used as a directory name so
// a crafted `?conversationId=../..` can't write outside the uploads tree.
const CONV_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Ensure uploads directory exists (needed before @fastify/static registers)
try { mkdirSync(UPLOADS_DIR, { recursive: true }) } catch { /* may fail outside Docker */ }
try { mkdirSync(PRIVATE_UPLOADS_DIR, { recursive: true, mode: 0o700 }) } catch { /* as above */ }

interface StoredFile {
  filename: string
  url: string
  path: string
}

/**
 * Move a private conversation's attachments out of the agent's workspace.
 *
 * Files are uploaded before the message that carries them is sent, and a new
 * chat only becomes private with its first local message — so the upload may
 * have landed in `uploads/`. The local turn calls this before it writes the
 * message, and the metadata stores the new place. Anything not under
 * `uploads/` (already private, or not ours) is left as it is.
 */
export function privatizeAttachments<T extends StoredFile>(conversationId: string, attachments: T[]): T[] {
  return attachments.map((a) => {
    const from = resolve(a.path)
    if (!from.startsWith(UPLOADS_DIR + sep) || !existsSync(from)) return a
    const dir = join(PRIVATE_UPLOADS_DIR, conversationId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const name = basename(from)
    const to = join(dir, name)
    try {
      renameSync(from, to)
    } catch {
      cpSync(from, to)
      rmSync(from, { force: true })
    }
    const rel = `${conversationId}/${name}`
    return { ...a, filename: rel, url: `${PRIVATE_URL_PREFIX}${rel}`, path: to }
  })
}

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
    // Relative to the root — this is the identity used in the url and stored
    // on the message, so it must carry the subdirectory when there is one.
    const relName = subdir ? `${subdir}/${id}${ext}` : `${id}${ext}`
    // Straight to private storage when the conversation already is private.
    const priv = !!subdir && isPrivateConversation(subdir)
    const root = priv ? PRIVATE_UPLOADS_DIR : UPLOADS_DIR
    const filePath = join(root, relName)

    if (subdir) mkdirSync(join(root, subdir), { recursive: true })

    await pipeline(file.file, createWriteStream(filePath))

    // Check if the stream was truncated (file too large)
    if (file.file.truncated) {
      // Clean up
      const { unlink } = await import('fs/promises')
      await unlink(filePath).catch(() => {})
      return reply.code(413).send({ error: 'File too large (max 100MB)' })
    }

    return {
      id,
      filename: relName,
      originalName: file.filename,
      mimetype: file.mimetype,
      size: file.file.bytesRead,
      url: priv ? `${PRIVATE_URL_PREFIX}${relName}` : `/api/uploads/files/${relName}`,
      // Path accessible by Claude inside the container
      path: filePath,
    }
  })

  done()
}

export { UPLOADS_DIR, PRIVATE_UPLOADS_DIR, PRIVATE_URL_PREFIX, MAX_FILE_SIZE }
