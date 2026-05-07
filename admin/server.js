const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const PORT = parseInt(process.env.PORT || '3006')
const REPO_DIR = process.env.REPO_DIR || '/jarvis'
const DOCKER_SOCKET = '/var/run/docker.sock'

// Safe git wrapper — uses execFileSync (no shell) to prevent injection
function git(...args) {
  return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8', timeout: 10000 })
}

// Restart a container via Docker Engine API over unix socket
function restartContainer(name) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: `/v1.44/containers/${name}/restart?t=5`,
        method: 'POST',
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          if (res.statusCode === 204 || res.statusCode === 200) resolve()
          else reject(new Error(`Docker API ${res.statusCode}: ${body}`))
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch {
        resolve({})
      }
    })
  })
}

async function handleApi(req, res) {
  try {
    // GET /api/status — git status + recent commits
    if (req.method === 'GET' && req.url === '/api/status') {
      const status = git('status', '--porcelain')
      const branch = git('branch', '--show-current').trim()
      const logRaw = git('log', '--format=%H|%s|%ai', '-10')
      const commits = logRaw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, ...rest] = line.split('|')
          return { hash, message: rest.slice(0, -1).join('|'), date: rest.at(-1) }
        })
      const dirty = status.trim().length > 0
      const files = dirty
        ? status
            .trim()
            .split('\n')
            .map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3) }))
        : []
      return json(res, 200, { branch, dirty, files, commits })
    }

    // GET /api/diff — uncommitted changes
    if (req.method === 'GET' && req.url === '/api/diff') {
      const diff = git('diff')
      const staged = git('diff', '--staged')
      return json(res, 200, { diff, staged })
    }

    // GET /api/show?hash=abc123 — show a specific commit
    if (req.method === 'GET' && req.url.startsWith('/api/show?')) {
      const hash = new URL(req.url, 'http://localhost').searchParams.get('hash')
      if (!hash || !/^[a-f0-9]+$/.test(hash)) {
        return json(res, 400, { error: 'Invalid hash' })
      }
      const diff = git('show', '--stat', '--format=%H|%s|%ai', hash)
      return json(res, 200, { diff })
    }

    // POST /api/discard — discard all uncommitted changes
    if (req.method === 'POST' && req.url === '/api/discard') {
      git('checkout', '--', '.')
      git('clean', '-fd')
      return json(res, 200, { ok: true, message: 'Uncommitted changes discarded' })
    }

    // POST /api/revert — reset last commit
    if (req.method === 'POST' && req.url === '/api/revert') {
      git('reset', '--hard', 'HEAD~1')
      return json(res, 200, { ok: true, message: 'Last commit reverted (reset --hard HEAD~1)' })
    }

    // POST /api/restart — restart jarvis backend + frontend containers
    if (req.method === 'POST' && req.url === '/api/restart') {
      const errors = []
      for (const name of ['jarvis-backend', 'jarvis']) {
        try {
          await restartContainer(name)
        } catch (err) {
          errors.push(`${name}: ${err.message}`)
        }
      }
      if (errors.length) {
        return json(res, 500, { ok: false, errors })
      }
      return json(res, 200, { ok: true, message: 'Backend and frontend restarting' })
    }

    json(res, 404, { error: 'Not found' })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    return handleApi(req, res)
  }

  // Serve the static recovery page
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Failed to load admin page')
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Jarvis admin recovery page running on :${PORT}`)
})
