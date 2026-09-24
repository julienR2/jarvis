import type { FastifyInstance } from 'fastify'
import { execFileSync, spawnSync } from 'child_process'
import { readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

const REPO_DIR = process.env.JARVIS_REPO_DIR || '/jarvis'
const MAX_FILE_SIZE = 1_000_000

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_DIR,
    encoding: 'utf8',
    timeout: 15000,
    // Default is 1 MiB — too small for e.g. `ls-files` on a big tree, which
    // would throw ENOBUFS and 500 the request. Match gitBuffer's ceiling.
    maxBuffer: 50 * 1024 * 1024,
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

// Dependency / VCS dirs that would balloon the listing (and aren't worth
// browsing). An app's node_modules alone can hold 100k+ files.
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store'])

// Accumulate into a shared array — never `results.push(...walkDir())`, since
// spreading a large array as call arguments overflows the stack (~125k limit).
function walkDir(dir: string, base: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue
      walkDir(full, base, out)
    } else if (entry.isFile()) {
      out.push(relative(base, full))
    }
  }
  return out
}

/**
 * Which of these repo-relative paths git ignores (a directory is given with a
 * trailing slash). check-ignore exits 1 when none are, so its status is not an
 * error here — only its output counts.
 */
function ignoredOf(paths: string[]): Set<string> {
  if (paths.length === 0) return new Set()
  const r = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: REPO_DIR,
    input: paths.join('\n'),
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return new Set((r.stdout || '').split('\n').filter(Boolean))
}

// A directory listing stops here: a dependency folder can hold thousands of
// entries, and nobody reads past the first screens of one.
const LS_LIMIT = 500

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

  // All files in the agent config dir (including git-ignored), no status
  app.get('/agent-tree', auth, async () => {
    const agentDir = process.env.CLAUDE_CONFIG_DIR || '/jarvis/agent'
    const paths = walkDir(agentDir, agentDir).sort()
    return paths.map((path) => ({ path, status: null }))
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

  // One directory of the working tree, one level deep — the code browser
  // expands folders on demand instead of loading the repo at once, so an app's
  // node_modules costs nothing until someone opens it. Each entry says whether
  // git ignores it; a file carries its status, a folder how many changed files
  // it holds. Files deleted but not yet committed are listed too, since that is
  // a change worth seeing and the disk no longer has them.
  app.get<{ Querystring: { path?: string } }>('/ls', auth, async (req, reply) => {
    const rel = (req.query.path || '').replace(/^\/+|\/+$/g, '')
    const abs = rel ? resolveRepoPath(rel) : REPO_DIR
    if (!abs) return reply.code(403).send({ error: 'Access denied' })

    let dirents
    try {
      dirents = readdirSync(abs, { withFileTypes: true }).filter((d) => d.name !== '.git')
    } catch {
      return reply.code(404).send({ error: 'Not a directory' })
    }
    dirents.sort((a, b) =>
      a.isDirectory() !== b.isDirectory() ? (a.isDirectory() ? -1 : 1) : a.name.localeCompare(b.name),
    )
    const truncated = dirents.length > LS_LIMIT
    const listed = dirents.slice(0, LS_LIMIT)
    const prefix = rel ? `${rel}/` : ''
    const pathOf = (name: string) => prefix + name

    // Inside an ignored folder everything is ignored; no need to ask per entry.
    const parentIgnored = rel ? ignoredOf([`${rel}/`]).size > 0 : false
    const ignored = parentIgnored
      ? null
      : ignoredOf(listed.map((d) => pathOf(d.name) + (d.isDirectory() ? '/' : '')))
    // Untracked files one by one, not their folder as a single line: a folder
    // counts its changed files, and "changes only" needs the files themselves.
    const status = parentIgnored
      ? new Map<string, string>()
      : parseStatus(git('status', '--porcelain', '--untracked-files=all', '--', rel || '.'))

    const entries = listed.map((d) => {
      const path = pathOf(d.name)
      const dir = d.isDirectory()
      const isIgnored = parentIgnored || !!ignored?.has(path + (dir ? '/' : ''))
      if (!dir) return { name: d.name, path, dir, ignored: isIgnored, status: status.get(path) ?? null, changes: 0 }
      let changes = 0
      for (const p of status.keys()) if (p.startsWith(`${path}/`)) changes++
      return { name: d.name, path, dir, ignored: isIgnored, status: null, changes }
    })
    for (const [p, st] of status) {
      if (st.includes('D') && dirname(p) === (rel || '.') && !entries.some((e) => e.path === p)) {
        entries.push({ name: p.slice(prefix.length), path: p, dir: false, ignored: false, status: st, changes: 0 })
      }
    }
    return { path: rel, entries, truncated }
  })

  // Every changed file, untracked ones listed one by one — the code browser's
  // "changes only" view, and all it needs.
  app.get('/changes', auth, async () => {
    const status = parseStatus(git('status', '--porcelain', '--untracked-files=all'))
    return [...status].map(([path, st]) => ({ path, status: st }))
  })

  // Single file — returns status, diff (if changed), and content (if text)
  app.get<{ Querystring: { path?: string } }>('/file', auth, async (req, reply) => {
    const rel = req.query.path
    if (!rel) return reply.code(400).send({ error: 'path required' })

    const abs = resolveRepoPath(rel)
    if (!abs) return reply.code(403).send({ error: 'Access denied' })
    // Listed in the tree (dimmed, ignored) but never shown: these hold the
    // instance's secrets, and a browser tab is no place for them.
    const base = rel.split('/').pop() ?? ''
    if ((/^\.env(\.|$)/.test(base) && base !== '.env.example') || base === 'secrets.json') {
      return reply.code(403).send({ error: 'This file holds secrets and is not shown here.' })
    }

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
