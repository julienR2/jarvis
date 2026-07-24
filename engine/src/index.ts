import Fastify from 'fastify'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { readFileSync, existsSync } from 'fs'

// The shared INTERNAL_SECRET is the auth token for this service AND is needed by
// Claude subprocesses to call the backend's /internal/* API. Read it fresh (not
// cached at module load) so that on a cold boot — where the backend generates and
// persists the secret only after the engine has started — the engine picks it up
// as soon as secrets.json appears, without a restart.
function internalSecret(): string | undefined {
  const env = process.env.INTERNAL_SECRET
  if (env && env !== 'internal') return env
  try {
    const secretsPath = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'
    return JSON.parse(readFileSync(secretsPath, 'utf8')).internal || undefined
  } catch { return undefined }
}

// Back-fill the Claude OAuth token from the persisted secrets file when it is
// not already in the environment. Read fresh (not cached) so a token saved via
// the onboarding flow is usable immediately, without a container restart.
function claudeOauthToken(): string | undefined {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN
  try {
    const secretsPath = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'
    return JSON.parse(readFileSync(secretsPath, 'utf8')).claudeOauthToken || undefined
  } catch { return undefined }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ClaudeEvent =
  | { type: 'thinking' }
  | { type: 'tool'; name: string }
  | { type: 'chunk'; text: string }
  | { type: 'done'; result: string; sessionId: string | null }
  | { type: 'error'; message: string }

interface Invocation {
  id: string
  conversationId: string
  process: ChildProcess
  events: ClaudeEvent[]
  subscribers: Set<(event: ClaudeEvent) => void>
  status: 'running' | 'done' | 'error'
  result?: string
  sessionId?: string | null
  startedAt: number
  endedAt?: number
  // Spawn context kept for session-lost retry
  prompt: string
  initialSessionId: string | null
  model?: string
  effort?: string
  allowRetry: boolean
  envVars?: Record<string, string>
}

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3010')
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/jarvis/agent/workspace'
const MAX_EVENTS = 1000
const CLEANUP_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── State ────────────────────────────────────────────────────────────────────

const invocations = new Map<string, Invocation>()
// Index secondaire : conversationId → invocationId (la plus récente encore active)
const activeByConversation = new Map<string, string>()

// ── Helpers ──────────────────────────────────────────────────────────────────

function pushEvent(inv: Invocation, event: ClaudeEvent): void {
  inv.events.push(event)
  if (inv.events.length > MAX_EVENTS) {
    inv.events.shift()
  }
  for (const sub of inv.subscribers) {
    try {
      sub(event)
    } catch (err) {
      console.error('[engine] subscriber error:', err)
    }
  }
}

function scheduleCleanup(invocationId: string): void {
  setTimeout(() => {
    const inv = invocations.get(invocationId)
    if (inv && inv.status !== 'running' && inv.subscribers.size === 0) {
      invocations.delete(invocationId)
      console.log(`[engine] cleaned up invocation ${invocationId}`)
    } else if (inv && inv.status !== 'running') {
      // Subscribers still around — retry later
      scheduleCleanup(invocationId)
    }
  }, CLEANUP_TTL_MS)
}

// Mark an invocation failed and — critically — release the per-conversation
// lock. Without this, a failed spawn leaves status='running' forever and every
// later /invoke for the conversation gets a permanent 409 (see spawnClaudeProcess).
function failInvocation(inv: Invocation, message: string): void {
  inv.status = 'error'
  inv.endedAt = Date.now()
  if (activeByConversation.get(inv.conversationId) === inv.id) {
    activeByConversation.delete(inv.conversationId)
  }
  pushEvent(inv, { type: 'error', message })
  scheduleCleanup(inv.id)
}

// ── Claude process spawning ──────────────────────────────────────────────────

function spawnClaudeProcess(inv: Invocation, sessionId: string | null): void {
  const BASE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill']
  const MCP_TOOLS = ['mcp__playwright']

  // NB: the prompt is fed over stdin (see below), NOT passed as an argv entry.
  // A large prompt (e.g. a full HTML email payload) exceeds the OS single-arg
  // limit (MAX_ARG_STRLEN, 128 KiB on Linux) and makes spawn() fail with E2BIG.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    [...BASE_TOOLS, ...MCP_TOOLS].join(','),
  ]

  const mcpConfig = `${process.env.CLAUDE_CONFIG_DIR || '/jarvis/agent'}/mcp.json`
  if (existsSync(mcpConfig)) args.push('--mcp-config', mcpConfig)

  if (sessionId) args.push('--resume', sessionId)
  if (inv.model) args.push('--model', inv.model)
  // Effort level (low|medium|high|xhigh|max). Haiku uses classic extended
  // thinking rather than adaptive effort and errors if --effort is passed,
  // so skip the flag for it.
  if (inv.effort && !/haiku/i.test(inv.model ?? '')) {
    args.push('--effort', inv.effort)
  }

  console.log(
    '[claude] spawning:', 'claude', args.join(' '),
    `(prompt ${inv.prompt.length} chars via stdin)`,
  )

  // Curate the child env. The agent runs arbitrary Bash and fetches untrusted web
  // pages, so it must not inherit secrets it never needs — a prompt-injected page
  // could otherwise exfiltrate them. Stripped:
  //   JWT_SECRET      — the backend's token-signing key; with it the agent could forge
  //                     a valid token for any user, bypassing login entirely.
  //   ADMIN_PASSWORD/ — the owner's login. No skill needs it: the agent reaches the
  //   ADMIN_EMAIL       backend via INTERNAL_SECRET and writes to services (CopyParty)
  //                     directly with connector credentials, never by logging in.
  const { JWT_SECRET, ADMIN_PASSWORD, ADMIN_EMAIL, ...inheritedEnv } = process.env
  void JWT_SECRET; void ADMIN_PASSWORD; void ADMIN_EMAIL
  let proc: ChildProcess
  try {
    proc = spawn('claude', args, {
      env: {
        ...inheritedEnv,
        INTERNAL_SECRET: internalSecret() ?? inheritedEnv.INTERNAL_SECRET,
        ...(claudeOauthToken() ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken() } : {}),
        ...inv.envVars,
        JARVIS_CONVERSATION_ID: inv.conversationId,
      },
      cwd: WORKSPACE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err: any) {
    // spawn() throws synchronously for some failures (notably E2BIG). This
    // guard is what stops a failed spawn from wedging the conversation.
    console.error('[claude] spawn threw:', err)
    failInvocation(inv, `Claude failed to start: ${err?.message ?? err}`)
    return
  }

  inv.process = proc

  // Async spawn failures (ENOENT, and some E2BIG paths) arrive here, not as a
  // throw. Without a listener Node escalates 'error' to an uncaught exception.
  proc.on('error', (err: any) => {
    console.error('[claude] process error:', err)
    if (inv.status === 'running') {
      failInvocation(inv, `Claude process error: ${err?.message ?? err}`)
    }
  })

  // Feed the prompt over stdin (see the args note above re: E2BIG).
  proc.stdin!.on('error', (err) => console.error('[claude] stdin error:', err))
  proc.stdin!.write(inv.prompt)
  proc.stdin!.end()

  let buf = ''
  let accumulated = ''
  let result = ''
  let newSessionId: string | null = null
  let doneEmitted = false
  const runningTasks = new Set<string>()
  const QUIET_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'])
  const quietToolIds = new Set<string>()

  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)

        // Log raw event for debugging (omit large content)
        const logEv = { ...ev }
        if (logEv.message?.content) {
          logEv.message = {
            ...logEv.message,
            content: `[${logEv.message.content.length} blocks]`,
          }
        }
        if (logEv.result && logEv.result.length > 100) {
          logEv.result = logEv.result.slice(0, 100) + '...'
        }
        console.log('[claude event]', JSON.stringify(logEv))

        if (ev.session_id) newSessionId = ev.session_id

        // Track sub-agent lifecycle for progress detection
        if (ev.type === 'system') {
          if (ev.subtype === 'task_started' && ev.task_id) {
            runningTasks.add(ev.task_id)
            if (ev.description) {
              console.log('[claude] -> agent started:', ev.description)
              pushEvent(inv, { type: 'tool', name: ev.description })
            }
          }
          if (
            ev.subtype === 'task_notification' &&
            ev.task_id &&
            ev.status === 'completed'
          ) {
            runningTasks.delete(ev.task_id)
          }
        }

        if (ev.type === 'assistant' && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === 'tool_use') {
              if (QUIET_TOOLS.has(block.name) && !block.input?.description) {
                if (block.id) quietToolIds.add(block.id)
                console.log('[claude] -> tool (quiet):', block.name)
              } else {
                const label = block.input?.description ?? `Using ${block.name}...`
                console.log('[claude] -> tool:', label)
                pushEvent(inv, { type: 'tool', name: label })
              }
            }
            if (block.type === 'text' && block.text) {
              if (runningTasks.size > 0) {
                // Progress text while sub-agents running — treat as activity step
                console.log(
                  '[claude] -> progress:',
                  block.text.trim().slice(0, 80),
                )
                pushEvent(inv, { type: 'tool', name: block.text.trim() })
              } else {
                accumulated += block.text
                console.log(
                  '[claude] -> chunk:',
                  block.text.slice(0, 80) +
                  (block.text.length > 80 ? '...' : ''),
                )
                pushEvent(inv, { type: 'chunk', text: block.text + '\n' })
              }
            }
          }
        }

        // Tool result comes as a "user" event with tool_use_result
        if (ev.type === 'user' && ev.tool_use_result) {
          const r = ev.tool_use_result
          const toolUseId = r.tool_use_id || ev.tool_use_id
          if (toolUseId && quietToolIds.has(toolUseId)) {
            quietToolIds.delete(toolUseId)
            console.log('[claude] -> tool_result (quiet)')
          } else {
            const output = (r.stdout || r.stderr || '').trim()
            if (output) {
              const firstLine = output.split('\n')[0].slice(0, 120)
              console.log('[claude] -> tool_result:', firstLine)
              pushEvent(inv, { type: 'tool', name: `→ ${firstLine}` })
            }
          }
          pushEvent(inv, { type: 'thinking' })
        }

        if (ev.type === 'result' && ev.subtype === 'success') {
          result = ev.result?.trim() || accumulated.trim()
          console.log('[claude] -> result received, length:', result.length)
          // Emit done immediately — don't wait for process close
          doneEmitted = true
          inv.status = 'done'
          inv.result = result || '(no response)'
          inv.sessionId = newSessionId
          inv.endedAt = Date.now()
          if (activeByConversation.get(inv.conversationId) === inv.id) {
            activeByConversation.delete(inv.conversationId)
          }
          pushEvent(inv, {
            type: 'done',
            result: result || '(no response)',
            sessionId: newSessionId,
          })
          scheduleCleanup(inv.id)
        }
      } catch {
        // non-JSON output from claude CLI, ignore
      }
    }
  })

  let stderr = ''
  proc.stderr!.on('data', (d: Buffer) => {
    const text = d.toString().trimEnd()
    stderr += text + '\n'
    console.error('[claude stderr]', text)
  })

  proc.on('close', (code) => {
    console.log(
      `[claude] process closed with code ${code}, session: ${newSessionId}`,
    )

    // Already resolved (success) or already failed via the 'error' handler.
    if (doneEmitted || inv.status !== 'running') return

    // Session-lost fallback: if --resume failed because the session no longer
    // exists, retry once without --resume. Claude will start a fresh session;
    // the caller persists the new session_id on 'done'.
    if (
      code !== 0 &&
      inv.allowRetry &&
      sessionId &&
      stderr.includes('No conversation found with session ID')
    ) {
      console.warn(
        `[claude] session ${sessionId} not found — retrying without --resume`,
      )
      inv.allowRetry = false
      spawnClaudeProcess(inv, null)
      return
    }

    if (code === 0) {
      console.warn(
        '[claude] process exited 0 without result event — fallback done',
      )
      inv.status = 'done'
      inv.result = result || accumulated || '(no response)'
      inv.sessionId = newSessionId
      inv.endedAt = Date.now()
      if (activeByConversation.get(inv.conversationId) === inv.id) {
        activeByConversation.delete(inv.conversationId)
      }
      pushEvent(inv, {
        type: 'done',
        result: result || accumulated || '(no response)',
        sessionId: newSessionId,
      })
      scheduleCleanup(inv.id)
    } else {
      console.error(`[claude] exited with code ${code}`)
      inv.status = 'error'
      inv.endedAt = Date.now()
      if (activeByConversation.get(inv.conversationId) === inv.id) {
        activeByConversation.delete(inv.conversationId)
      }
      pushEvent(inv, {
        type: 'error',
        message: `Claude exited with code ${code}: ${stderr.trim() || 'no stderr output'}`,
      })
      scheduleCleanup(inv.id)
    }
  })
}

// ── Fastify app ──────────────────────────────────────────────────────────────

const app = Fastify({ logger: false })

// Require the shared internal secret on every request except /health. /invoke runs
// arbitrary Claude prompts (Bash/Write/Edit enabled), so this endpoint must never be
// callable by other containers on the shared `homelab` network — the Bearer check is
// the only thing standing between a compromised neighbour and code execution here.
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return
  const secret = internalSecret()
  if (!secret || req.headers['authorization'] !== `Bearer ${secret}`) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
})

// POST /invoke — spawn a claude process for a conversation
app.post<{
  Body: {
    prompt: string
    sessionId: string | null
    conversationId: string
    model?: string
    effort?: string
    envVars?: Record<string, string>
  }
}>('/invoke', async (req, reply) => {
  const { prompt, sessionId, conversationId, model, effort, envVars } = req.body || ({} as any)

  if (!prompt || !conversationId) {
    return reply.code(400).send({ error: 'prompt and conversationId are required' })
  }

  // Concurrency guard — only one running process per conversation
  const existing = activeByConversation.get(conversationId)
  if (existing) {
    const existingInv = invocations.get(existing)
    if (existingInv && existingInv.status === 'running') {
      return reply
        .code(409)
        .send({ error: 'already running for this conversation', invocationId: existing })
    }
  }

  const id = randomUUID()
  const inv: Invocation = {
    id,
    conversationId,
    // placeholder — replaced by spawnClaudeProcess
    process: null as unknown as ChildProcess,
    events: [],
    subscribers: new Set(),
    status: 'running',
    startedAt: Date.now(),
    prompt,
    initialSessionId: sessionId ?? null,
    model,
    effort,
    allowRetry: true,
    envVars: envVars || undefined,
  }

  invocations.set(id, inv)
  activeByConversation.set(conversationId, id)

  spawnClaudeProcess(inv, sessionId ?? null)

  return { invocationId: id }
})

// GET /stream/:invocationId — SSE stream of events (replay + live)
app.get<{ Params: { invocationId: string } }>(
  '/stream/:invocationId',
  async (req, reply) => {
    const inv = invocations.get(req.params.invocationId)
    if (!inv) return reply.code(404).send({ error: 'invocation not found' })

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write('\n')
    reply.hijack()

    // Replay buffered events
    for (const ev of inv.events) {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`)
    }

    // If already terminated, send terminator and close
    if (inv.status !== 'running') {
      reply.raw.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`)
      reply.raw.end()
      return
    }

    // Subscribe to live events
    const handler = (ev: ClaudeEvent) => {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`)
      if (ev.type === 'done' || ev.type === 'error') {
        reply.raw.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`)
        reply.raw.end()
      }
    }
    inv.subscribers.add(handler)

    // Heartbeat to keep connection alive through proxies
    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n')
    }, 30000)

    req.raw.on('close', () => {
      inv.subscribers.delete(handler)
      clearInterval(heartbeat)
    })
  },
)

// POST /cancel/:invocationId — SIGTERM the process
app.post<{ Params: { invocationId: string } }>(
  '/cancel/:invocationId',
  async (req, reply) => {
    const inv = invocations.get(req.params.invocationId)
    if (!inv) return reply.code(404).send({ error: 'invocation not found' })

    if (inv.status === 'running' && inv.process) {
      inv.process.kill('SIGTERM')
      inv.status = 'error'
      inv.endedAt = Date.now()
      if (activeByConversation.get(inv.conversationId) === inv.id) {
        activeByConversation.delete(inv.conversationId)
      }
      pushEvent(inv, { type: 'error', message: 'cancelled' })
      scheduleCleanup(inv.id)
    }

    return { ok: true }
  },
)

// GET /status — all invocations
app.get('/status', async () => {
  const list = []
  for (const inv of invocations.values()) {
    list.push({
      id: inv.id,
      conversationId: inv.conversationId,
      status: inv.status,
      startedAt: inv.startedAt,
      endedAt: inv.endedAt,
      eventCount: inv.events.length,
    })
  }
  return { invocations: list }
})

// GET /running/:conversationId — is a claude process active for this conversation?
app.get<{ Params: { conversationId: string } }>(
  '/running/:conversationId',
  async (req) => {
    const id = activeByConversation.get(req.params.conversationId)
    if (!id) return { running: false }
    const inv = invocations.get(id)
    if (!inv || inv.status !== 'running') return { running: false }
    return { running: true, invocationId: id }
  },
)

// Health check
app.get('/health', async () => ({ ok: true }))

// ── Start ────────────────────────────────────────────────────────────────────

await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`Jarvis engine running on :${PORT}`)
