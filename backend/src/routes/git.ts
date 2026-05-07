import type { FastifyInstance } from 'fastify'
import { execFileSync } from 'child_process'

const REPO_DIR = process.env.JARVIS_REPO_DIR || '/jarvis'

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_DIR,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
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

  // Show a specific commit diff
  app.get<{ Params: { hash: string } }>('/log/:hash', auth, async (req, reply) => {
    const { hash } = req.params
    // Only allow hex hashes to prevent injection
    if (!/^[a-f0-9]{4,40}$/.test(hash)) {
      return reply.code(400).send({ error: 'Invalid hash' })
    }
    const stat = git('show', '--stat', '--format=%H%n%s%n%an%n%ai', hash)
    const diff = git('show', '--format=', hash)
    const lines = stat.split('\n')
    return {
      hash: lines[0],
      message: lines[1],
      author: lines[2],
      date: lines[3],
      stat: lines.slice(4).join('\n'),
      diff,
    }
  })

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
}
