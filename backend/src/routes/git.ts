import type { FastifyInstance } from 'fastify'
import { execFileSync } from 'child_process'
import { readFileSync, statSync } from 'fs'
import { resolve } from 'path'

const REPO_DIR = process.env.JARVIS_REPO_DIR || '/jarvis'
const MAX_FILE_SIZE = 1_000_000

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_DIR,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

function gitBuffer(...args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd: REPO_DIR,
    timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 50 * 1024 * 1024,
  })
}

function parseStatus(porcelain: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of porcelain.split('\n')) {
    if (!line) continue
    map.set(line.slice(3), line.slice(0, 2))
  }
  return map
}

function resolveRepoPath(rel: string): string | null {
  if (!rel || rel.includes('\0')) return null
  const abs = resolve(REPO_DIR, rel)
  if (abs !== REPO_DIR && !abs.startsWith(REPO_DIR + '/')) return null
  return abs
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export async function gitRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  // Git status — branch, dirty flag, changed files
  app.get('/status', auth, async () => {
    const status = git('status', '--porcelain')
    const branch = git('branch', '--show-current').trim()
    const dirty = status.trim().length > 0
    const files = dirty
      ? status
          .trim()
          .split('\n')
          .map((line) => ({
            status: line.slice(0, 2).trim(),
            file: line.slice(3),
          }))
      : []
    return { branch, dirty, files }
  })

  // Uncommitted diff (both staged and unstaged)
  app.get('/diff', auth, async () => {
    const diff = git('diff')
    const staged = git('diff', '--staged')
    return { diff, staged }
  })

  // Commit log — recent commits
  app.get<{ Querystring: { limit?: string } }>('/log', auth, async (req) => {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100)
    const logRaw = git('log', `--format=%H|%s|%an|%ai`, `-${limit}`)
    const commits = logRaw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|')
        const hash = parts[0]
        const date = parts.at(-1)
        const author = parts.at(-2)
        const message = parts.slice(1, -2).join('|')
        return { hash, message, author, date }
      })
    return commits
  })

  // Commit metadata + list of files it touched (lightweight — no diff)
  app.get<{ Params: { hash: string } }>('/log/:hash', auth, async (req, reply) => {
    const { hash } = req.params
    if (!/^[a-f0-9]{4,40}$/.test(hash)) {
      return reply.code(400).send({ error: 'Invalid hash' })
    }
    const meta = git('show', '--no-patch', '--format=%H%n%s%n%an%n%ai', hash).split('\n')
    const raw = git('show', '--name-status', '--format=', hash).trim()
    const files = raw
      ? raw.split('\n').map((line) => {
          const parts = line.split('\t')
          return { status: parts[0], path: parts[parts.length - 1] }
        })
      : []
    return {
      hash: meta[0],
      message: meta[1],
      author: meta[2],
      date: meta[3],
      files,
    }
  })

  // Diff of a single file at a specific commit
  app.get<{ Params: { hash: string }; Querystring: { path?: string } }>(
    '/log/:hash/file',
    auth,
    async (req, reply) => {
      const { hash } = req.params
      const path = req.query.path
      if (!/^[a-f0-9]{4,40}$/.test(hash)) {
        return reply.code(400).send({ error: 'Invalid hash' })
      }
      if (!path) return reply.code(400).send({ error: 'path required' })
      if (!resolveRepoPath(path)) return reply.code(403).send({ error: 'Access denied' })
      let diff: string
      try {
        diff = gitBuffer('show', '--format=', hash, '--', path).toString('utf8')
      } catch {
        diff = ''
      }
      return { path, diff }
    },
  )

  // Commit all current changes
  app.post<{ Body: { message: string } }>('/commit', auth, async (req, reply) => {
    const { message } = req.body || {}
    if (!message || typeof message !== 'string') {
      return reply.code(400).send({ error: 'message is required' })
    }
    git('add', '-A')
    git('commit', '-m', message)
    return { ok: true }
  })

  // Discard all uncommitted changes
  app.post('/discard', auth, async () => {
    git('checkout', '--', '.')
    git('clean', '-fd')
    return { ok: true, message: 'Uncommitted changes discarded' }
  })

  // Revert (reset) last commit
  app.post('/revert', auth, async () => {
    git('reset', '--hard', 'HEAD~1')
    return { ok: true, message: 'Last commit reverted' }
  })

  // Flat tree of all tracked + untracked (non-ignored) files with their status
  app.get('/tree', auth, async () => {
    const files = git('ls-files', '-co', '--exclude-standard')
      .split('\n')
      .filter(Boolean)
      .sort()
    const status = parseStatus(git('status', '--porcelain'))
    return files.map((path) => ({ path, status: status.get(path) || null }))
  })

  // Single file — returns status, diff (if changed), and content (if text)
  app.get<{ Querystring: { path?: string } }>('/file', auth, async (req, reply) => {
    const rel = req.query.path
    if (!rel) return reply.code(400).send({ error: 'path required' })

    const abs = resolveRepoPath(rel)
    if (!abs) return reply.code(403).send({ error: 'Access denied' })

    // Status
    const porcelain = git('status', '--porcelain', '--', rel).trim()
    const status = porcelain ? porcelain.slice(0, 2) : null

    // Read file content (may be missing if deleted)
    let content: string | null = null
    let binary = false
    let tooLarge = false
    try {
      const stat = statSync(abs)
      if (!stat.isFile()) return reply.code(400).send({ error: 'Not a file' })
      if (stat.size > MAX_FILE_SIZE) {
        tooLarge = true
      } else {
        const buf = readFileSync(abs)
        if (isBinary(buf)) binary = true
        else content = buf.toString('utf8')
      }
    } catch {
      // File doesn't exist (likely status 'D')
    }

    // Diff vs HEAD (covers staged + unstaged). Untracked files aren't
    // represented in HEAD, so the client renders their content as all-additions.
    let diff: string | null = null
    const isUntracked = status?.includes('?') ?? false
    if (status && !isUntracked) {
      try {
        diff = gitBuffer('diff', 'HEAD', '--', rel).toString('utf8')
      } catch {
        diff = null
      }
    }

    return { path: rel, status, content, binary, tooLarge, diff }
  })
}
