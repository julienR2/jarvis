import Fastify from 'fastify'
import { spawn } from 'child_process'
import { WORKSPACE_DIR, internalSecret, secureEquals } from './shared.js'
import {
  ensureSession,
  getSession,
  isBusy,
  listSessions,
  sendUserMessage,
  interruptSession,
  answerSession,
  recycleIdleSessions,
  type SessionEvent,
} from './sessions.js'

const PORT = parseInt(process.env.PORT || '3010')

const app = Fastify({ logger: false })

// Require the shared internal secret on every request except /health. /message
// runs arbitrary Claude prompts (Bash/Write/Edit enabled), so this endpoint must
// never be callable by other containers on the shared `homelab` network — the
// Bearer check is the only thing standing between a compromised neighbour and
// code execution here.
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return
  const secret = internalSecret()
  const auth = req.headers['authorization']
  if (!secret || typeof auth !== 'string' || !secureEquals(auth, `Bearer ${secret}`)) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
})

// POST /message — feed a user message into the conversation's persistent
// session (spawning it on first use). Never refuses a busy conversation: the
// CLI receives mid-turn messages immediately and steers/queues them itself.
app.post<{
  Body: {
    prompt: string
    sessionId?: string | null
    conversationId: string
    model?: string
    effort?: string
    envVars?: Record<string, string>
    oneShot?: boolean
  }
}>('/message', async (req, reply) => {
  const { prompt, sessionId, conversationId, model, effort, envVars, oneShot } =
    req.body || ({} as any)

  if (!prompt || !conversationId) {
    return reply.code(400).send({ error: 'prompt and conversationId are required' })
  }

  const sess = ensureSession({
    conversationId,
    resumeSessionId: sessionId ?? null,
    model,
    effort,
    envVars,
    oneShot,
  })
  const queued = sendUserMessage(sess, prompt)
  return { ok: true, queued }
})

// POST /interrupt/:conversationId — soft-cancel the current turn (control
// protocol). The session survives; only the in-flight turn stops.
app.post<{ Params: { conversationId: string } }>(
  '/interrupt/:conversationId',
  async (req) => {
    const interrupted = interruptSession(req.params.conversationId)
    return { ok: true, interrupted }
  },
)

// POST /answer/:conversationId — answer a parked prompt (question or
// permission request) so the turn resumes. 404 when nothing by that request id
// is waiting: the session ended, the prompt was withdrawn, or it was already
// answered — in every case the caller should stop showing the card.
app.post<{
  Params: { conversationId: string }
  Body: {
    requestId: string
    behavior: 'allow' | 'deny'
    updatedInput?: Record<string, unknown>
    message?: string
  }
}>('/answer/:conversationId', async (req, reply) => {
  const { requestId, behavior, updatedInput, message } = req.body || ({} as any)
  if (!requestId || (behavior !== 'allow' && behavior !== 'deny')) {
    return reply.code(400).send({ error: 'requestId and behavior (allow|deny) are required' })
  }
  const answered = answerSession(
    req.params.conversationId,
    requestId,
    behavior === 'allow' ? { behavior, updatedInput } : { behavior, message },
  )
  if (!answered) return reply.code(404).send({ error: 'no such pending prompt' })
  return { ok: true }
})

// GET /stream/:conversationId — SSE of the session's events: the current turn
// replayed, then live. Spans turns; ends only when the session itself closes
// (idle reap, eviction, process exit).
app.get<{ Params: { conversationId: string } }>(
  '/stream/:conversationId',
  async (req, reply) => {
    const sess = getSession(req.params.conversationId)
    if (!sess) return reply.code(404).send({ error: 'not found' })

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write('\n')
    reply.hijack()

    for (const ev of sess.events) {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`)
    }

    const handler = (ev: SessionEvent) => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`)
      if (ev.type === 'end') reply.raw.end()
    }
    sess.subscribers.add(handler)

    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n')
    }, 30000)

    req.raw.on('close', () => {
      sess.subscribers.delete(handler)
      clearInterval(heartbeat)
    })
  },
)

// POST /cancel/:conversationId — soft interrupt; the session stays alive.
app.post<{ Params: { conversationId: string } }>(
  '/cancel/:conversationId',
  async (req, reply) => {
    if (!getSession(req.params.conversationId)) {
      return reply.code(404).send({ error: 'no session' })
    }
    interruptSession(req.params.conversationId)
    return { ok: true }
  },
)

// GET /status — sessions, plus the conversation-level busy view the backend's
// restart-reconnect logic reads.
app.get('/status', async () => {
  const sessions = listSessions()
  const conversations = sessions.map((s) => ({
    conversationId: s.conversationId,
    busy: s.status === 'busy',
  }))
  return { sessions, conversations }
})

// GET /running/:conversationId — is a turn in flight for this conversation?
app.get<{ Params: { conversationId: string } }>(
  '/running/:conversationId',
  async (req) => ({ running: isBusy(req.params.conversationId) }),
)

// ── Connection ───────────────────────────────────────────────────────────────

// POST /verify-connection — does this credential actually work?
//
// The only trustworthy check is the real thing: spawn `claude` exactly the way
// a turn does, with the candidate credentials, and see whether it answers. A
// format check would happily accept the expired/mistyped token that leaves an
// instance failing every turn with no way back (the CLI only reports it at
// spawn time, which the chat surfaces as an opaque exit code).
app.post<{
  Body: { baseUrl?: string; authToken?: string; oauthToken?: string }
}>('/verify-connection', async (req) => {
  const { baseUrl, authToken, oauthToken } = req.body ?? {}

  const credentials: Record<string, string> = baseUrl
    ? {
        ANTHROPIC_BASE_URL: baseUrl,
        ...(authToken
          ? { ANTHROPIC_AUTH_TOKEN: authToken, ANTHROPIC_API_KEY: authToken }
          : {}),
        CLAUDE_CODE_OAUTH_TOKEN: '',
      }
    : {
        ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_AUTH_TOKEN: '',
      }

  const { JWT_SECRET, ADMIN_PASSWORD, ADMIN_EMAIL, ...inherited } = process.env
  void JWT_SECRET; void ADMIN_PASSWORD; void ADMIN_EMAIL

  return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false
    const finish = (r: { ok: boolean; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
      resolve(r)
    }

    // No tools, no MCP config, no session state — just enough to force an
    // authenticated round-trip to the provider.
    const proc = spawn('claude', ['-p', '--output-format', 'text'], {
      env: { ...inherited, ...credentials },
      cwd: WORKSPACE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const timer = setTimeout(
      () => finish({ ok: false, error: 'Timed out after 45s waiting for a reply.' }),
      45_000,
    )

    let stderr = ''
    let stdout = ''
    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString().slice(0, 2000) })

    proc.on('error', (err) =>
      finish({ ok: false, error: `Could not start claude: ${err.message}` }),
    )
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) return finish({ ok: true })
      const detail = stderr.trim() || stdout.trim() || `exit code ${code}`
      finish({ ok: false, error: detail.split('\n').slice(-4).join('\n').slice(0, 500) })
    })

    try {
      proc.stdin?.write('Reply with the single word: ok')
      proc.stdin?.end()
    } catch (err: any) {
      finish({ ok: false, error: `Could not write to claude: ${err?.message ?? err}` })
    }
  })
})

// POST /restart — exit so the container's restart policy brings the process
// back on the current source. What deploy.sh does to prod with a pkill from
// inside; this is the same thing reachable over HTTP, for the `next` engine
// (a separate container the agent cannot signal). Every live session ends.
app.post('/restart', async () => {
  console.warn('[engine] restart requested — exiting')
  setTimeout(() => process.exit(0), 300).unref()
  return { ok: true, restarting: true }
})

// POST /recycle — close idle sessions so the next turn spawns with fresh
// config (a provider switch). Busy sessions finish their turn on
// the old config and are reported back.
app.post('/recycle', async () => recycleIdleSessions())

// Health check
app.get('/health', async () => ({ ok: true }))

// ── Start ────────────────────────────────────────────────────────────────────

await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`Jarvis engine running on :${PORT}`)
