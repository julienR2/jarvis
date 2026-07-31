// Persistent Claude sessions — one long-lived `claude` process per
// conversation, fed user messages over stdin as stream-json events.
//
// Compared to the legacy one-shot stack (one process per message, stdin closed
// after the prompt), a live stdin means:
//   - messages sent while a turn is running reach the CLI immediately
//     (steering / queueing is handled by the CLI itself)
//   - background subagents survive between turns instead of dying with the
//     per-message process
//   - no --resume cold-start cost on every message
//
// A session dies when: it has been idle past ENGINE_IDLE_TTL_MS, the oldest
// idle one is evicted to respect ENGINE_MAX_SESSIONS, its model/effort changes
// (respawned with --resume), or the process exits. The claude session id is
// persisted by the backend after every turn, so any death is recoverable — the
// next message simply resumes.

import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import {
  type ClaudeEvent,
  WORKSPACE_DIR,
  MAX_EVENTS,
  internalSecret,
  claudeOauthToken,
} from './shared.js'

export type SessionEvent = ClaudeEvent | { type: 'end' }

export interface Session {
  conversationId: string
  proc: ChildProcess
  // busy = a turn is in flight (user message written, result not yet seen)
  status: 'busy' | 'idle'
  // Claude session id, stable for the lifetime of the process. Captured from
  // the init event; reported to the backend on every done event.
  claudeSessionId: string | null
  // Current-turn ring buffer, cleared at each idle→busy transition so a
  // reconnecting subscriber replays only the turn in progress.
  events: ClaudeEvent[]
  subscribers: Set<(ev: SessionEvent) => void>
  model?: string
  effort?: string
  envVars?: Record<string, string>
  startedAt: number
  lastActivityAt: number
  // User texts written since spawn but not yet answered by a result — replayed
  // if --resume points at a session the CLI no longer knows about.
  unanswered: string[]
  allowResumeRetry: boolean
  // One-shot sessions (title generation) close stdin after the first result.
  oneShot: boolean
  // A graceful close was initiated (reap, eviction, model change) — the close
  // handler must not report it as an error.
  closing: boolean
  // Escalation timer armed by interrupt() and graceful closes.
  killTimer: NodeJS.Timeout | null
  stderrTail: string
}

const IDLE_TTL_MS = parseInt(process.env.ENGINE_IDLE_TTL_MS || '') || 15 * 60 * 1000
const MAX_SESSIONS = parseInt(process.env.ENGINE_MAX_SESSIONS || '') || 8
// How long an interrupt or graceful close waits before SIGTERM.
const KILL_GRACE_MS = 8000

const sessions = new Map<string, Session>()

// ── Introspection ────────────────────────────────────────────────────────────

export function getSession(conversationId: string): Session | undefined {
  return sessions.get(conversationId)
}

export function isBusy(conversationId: string): boolean {
  return sessions.get(conversationId)?.status === 'busy'
}

export function listSessions(): Array<{
  conversationId: string
  status: 'busy' | 'idle'
  startedAt: number
  lastActivityAt: number
  model?: string
}> {
  return [...sessions.values()].map((s) => ({
    conversationId: s.conversationId,
    status: s.status,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    model: s.model,
  }))
}

// ── Events ───────────────────────────────────────────────────────────────────

function pushEvent(sess: Session, event: ClaudeEvent): void {
  sess.events.push(event)
  if (sess.events.length > MAX_EVENTS) sess.events.shift()
  emit(sess, event)
}

function emit(sess: Session, event: SessionEvent): void {
  for (const sub of sess.subscribers) {
    try {
      sub(event)
    } catch (err) {
      console.error('[session] subscriber error:', err)
    }
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export interface EnsureOptions {
  conversationId: string
  // claude session id persisted by the backend, used for --resume on spawn.
  resumeSessionId?: string | null
  model?: string
  effort?: string
  envVars?: Record<string, string>
  oneShot?: boolean
}

export function ensureSession(opts: EnsureOptions): Session {
  const existing = sessions.get(opts.conversationId)
  if (existing) {
    // Model or effort changed mid-conversation: the flags are argv-only, so
    // the process has to be replaced. Resume from its own live session id.
    if (
      (opts.model ?? existing.model) !== existing.model ||
      (opts.effort ?? existing.effort) !== existing.effort
    ) {
      const resumeId = existing.claudeSessionId ?? opts.resumeSessionId ?? null
      console.log(
        `[session] ${opts.conversationId}: model/effort change, respawning`,
      )
      closeSession(existing, { graceful: false })
      return createSession({ ...opts, resumeSessionId: resumeId })
    }
    return existing
  }
  return createSession(opts)
}

function createSession(opts: EnsureOptions): Session {
  // Respect the session cap by evicting the stalest idle session. Busy
  // sessions are never evicted — going over the cap beats killing live work.
  if (sessions.size >= MAX_SESSIONS) {
    const idle = [...sessions.values()]
      .filter((s) => s.status === 'idle')
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0]
    if (idle) {
      console.log(`[session] evicting idle ${idle.conversationId} (cap ${MAX_SESSIONS})`)
      closeSession(idle, { graceful: true })
    }
  }

  const sess: Session = {
    conversationId: opts.conversationId,
    proc: null as unknown as ChildProcess,
    status: 'idle',
    claudeSessionId: opts.resumeSessionId ?? null,
    events: [],
    subscribers: new Set(),
    model: opts.model,
    effort: opts.effort,
    envVars: opts.envVars,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    unanswered: [],
    allowResumeRetry: true,
    oneShot: opts.oneShot ?? false,
    closing: false,
    killTimer: null,
    stderrTail: '',
  }
  sessions.set(sess.conversationId, sess)
  spawnProcess(sess, opts.resumeSessionId ?? null)
  return sess
}

function spawnProcess(sess: Session, resumeSessionId: string | null): void {
  const BASE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill']
  const MCP_TOOLS = ['mcp__playwright']

  const args = [
    '-p',
    // Keeps the process alive reading user messages from stdin until we close it.
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    [...BASE_TOOLS, ...MCP_TOOLS].join(','),
  ]

  const mcpConfig = `${process.env.CLAUDE_CONFIG_DIR || '/jarvis/agent'}/mcp.json`
  if (existsSync(mcpConfig)) args.push('--mcp-config', mcpConfig)

  if (resumeSessionId) args.push('--resume', resumeSessionId)
  if (sess.model) args.push('--model', sess.model)
  // Effort level (low|medium|high|xhigh|max). Haiku uses classic extended
  // thinking rather than adaptive effort and errors if --effort is passed,
  // so skip the flag for it.
  if (sess.effort && !/haiku/i.test(sess.model ?? '')) {
    args.push('--effort', sess.effort)
  }

  console.log(`[session] ${sess.conversationId}: spawning claude ${args.join(' ')}`)

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
        ...sess.envVars,
        JARVIS_CONVERSATION_ID: sess.conversationId,
      },
      cwd: WORKSPACE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err: any) {
    console.error('[session] spawn threw:', err)
    failSession(sess, `Claude failed to start: ${err?.message ?? err}`)
    return
  }

  sess.proc = proc
  sess.stderrTail = ''

  proc.on('error', (err: any) => {
    console.error('[session] process error:', err)
    if (sessions.get(sess.conversationId) === sess && !sess.closing) {
      failSession(sess, `Claude process error: ${err?.message ?? err}`)
    }
  })

  proc.stdin!.on('error', (err) =>
    console.error('[session] stdin error:', err),
  )

  attachStdoutParser(sess, proc)

  proc.stderr!.on('data', (d: Buffer) => {
    const text = d.toString().trimEnd()
    sess.stderrTail = (sess.stderrTail + text + '\n').slice(-4000)
    console.error(`[session stderr ${sess.conversationId.slice(0, 8)}]`, text)
  })

  proc.on('close', (code) => {
    console.log(`[session] ${sess.conversationId}: process closed (code ${code})`)
    if (sess.killTimer) {
      clearTimeout(sess.killTimer)
      sess.killTimer = null
    }
    // A newer process already replaced this one (model change respawn).
    if (sessions.get(sess.conversationId) !== sess) return

    // --resume pointed at a session the CLI no longer has: retry once from
    // scratch and replay the messages that never got an answer.
    if (
      code !== 0 &&
      sess.allowResumeRetry &&
      resumeSessionId &&
      sess.stderrTail.includes('No conversation found with session ID')
    ) {
      console.warn(
        `[session] ${sess.conversationId}: session ${resumeSessionId} not found — retrying fresh`,
      )
      sess.allowResumeRetry = false
      sess.claudeSessionId = null
      spawnProcess(sess, null)
      for (const text of sess.unanswered) writeUserLine(sess, text)
      return
    }

    if (sess.closing) {
      // Graceful end (reap, eviction, one-shot completion).
      endSession(sess)
      return
    }

    if (sess.status === 'busy') {
      pushEvent(sess, {
        type: 'error',
        message: `Claude exited with code ${code}: ${sess.stderrTail.trim() || 'no stderr output'}`,
      })
    }
    endSession(sess)
  })
}

function attachStdoutParser(sess: Session, proc: ChildProcess): void {
  let buf = ''
  let accumulated = ''
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
        console.log('[session event]', JSON.stringify(logEv))

        if (ev.session_id) sess.claudeSessionId = ev.session_id
        sess.lastActivityAt = Date.now()

        // Track sub-agent lifecycle for progress detection
        if (ev.type === 'system') {
          if (ev.subtype === 'task_started' && ev.task_id) {
            runningTasks.add(ev.task_id)
            if (ev.description) {
              console.log('[session] -> agent started:', ev.description)
              pushEvent(sess, { type: 'tool', name: ev.description })
            }
          }
          // Any notification means the task reached a terminal state
          // (completed, failed, killed) — a task left in this set keeps the
          // session busy forever, so err on the side of removing.
          if (ev.subtype === 'task_notification' && ev.task_id) {
            runningTasks.delete(ev.task_id)
          }
        }

        if (ev.type === 'assistant' && ev.message?.content) {
          // Any assistant activity means a turn is in flight — covers turns the
          // CLI starts on its own (queued messages, subagent wake-ups).
          markBusy(sess)
          for (const block of ev.message.content) {
            if (block.type === 'tool_use') {
              if (QUIET_TOOLS.has(block.name) && !block.input?.description) {
                if (block.id) quietToolIds.add(block.id)
                console.log('[session] -> tool (quiet):', block.name)
              } else {
                const label = block.input?.description ?? `Using ${block.name}...`
                console.log('[session] -> tool:', label)
                pushEvent(sess, { type: 'tool', name: label })
              }
            }
            if (block.type === 'text' && block.text) {
              if (runningTasks.size > 0) {
                // Progress text while sub-agents running — treat as activity step
                console.log('[session] -> progress:', block.text.trim().slice(0, 80))
                pushEvent(sess, { type: 'tool', name: block.text.trim() })
              } else {
                accumulated += block.text
                console.log(
                  '[session] -> chunk:',
                  block.text.slice(0, 80) + (block.text.length > 80 ? '...' : ''),
                )
                pushEvent(sess, { type: 'chunk', text: block.text + '\n' })
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
            console.log('[session] -> tool_result (quiet)')
          } else {
            const output = (r.stdout || r.stderr || '').trim()
            if (output) {
              const firstLine = output.split('\n')[0].slice(0, 120)
              console.log('[session] -> tool_result:', firstLine)
              pushEvent(sess, { type: 'tool', name: `→ ${firstLine}` })
            }
          }
          pushEvent(sess, { type: 'thinking' })
        }

        if (ev.type === 'result') {
          const result =
            (typeof ev.result === 'string' && ev.result.trim()) ||
            accumulated.trim()
          console.log(
            '[session] -> result, length:', result.length,
            runningTasks.size > 0 ? `(${runningTasks.size} background task(s) pending)` : '',
          )
          accumulated = ''
          // One result answers every message steered into the turn, so clear
          // rather than shift — a leftover entry would read as a pending turn.
          sess.unanswered.length = 0
          // Background subagents keep the session busy: a wake-up turn is
          // coming, the idle reaper must not kill it, and a backend restart
          // must re-attach to it.
          sess.status = runningTasks.size > 0 ? 'busy' : 'idle'
          sess.lastActivityAt = Date.now()
          if (sess.killTimer) {
            clearTimeout(sess.killTimer)
            sess.killTimer = null
          }
          pushEvent(sess, {
            type: 'done',
            result: result || '(no response)',
            sessionId: sess.claudeSessionId,
            pending: runningTasks.size > 0,
          })
          // Reset the replay buffer at the turn boundary here, not only at the
          // next user message: turns the CLI starts on its own (background
          // subagent wake-ups) never pass through sendUserMessage, and their
          // replay must not drag the previous turn along.
          sess.events.length = 0
          if (sess.oneShot) {
            sess.closing = true
            sess.proc.stdin?.end()
            armKillTimer(sess)
          }
        }
      } catch {
        // non-JSON output from claude CLI, ignore
      }
    }
  })
}

// ── Messages in ──────────────────────────────────────────────────────────────

function writeUserLine(sess: Session, text: string): void {
  sess.proc.stdin!.write(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n',
  )
}

function markBusy(sess: Session): void {
  sess.status = 'busy'
}

/**
 * Feed a user message into the session. If a turn is already running the CLI
 * receives it immediately and decides (steer into the current turn or queue a
 * new one) — that's the whole point of the persistent process.
 * Returns whether the session was busy when the message arrived.
 */
export function sendUserMessage(sess: Session, text: string): boolean {
  const wasBusy = sess.status === 'busy'
  if (!wasBusy) {
    // Fresh turn: reset the replay buffer so late subscribers only see the
    // turn in progress, never a stale finished one.
    sess.events.length = 0
    markBusy(sess)
  }
  sess.unanswered.push(text)
  sess.lastActivityAt = Date.now()
  writeUserLine(sess, text)
  return wasBusy
}

// ── Interrupt / close ────────────────────────────────────────────────────────

function armKillTimer(sess: Session): void {
  if (sess.killTimer) clearTimeout(sess.killTimer)
  sess.killTimer = setTimeout(() => {
    console.warn(`[session] ${sess.conversationId}: grace expired, SIGTERM`)
    sess.proc.kill('SIGTERM')
  }, KILL_GRACE_MS)
}

/**
 * Soft-cancel the current turn via the CLI control protocol. The session and
 * its context survive; only the in-flight turn stops (the CLI answers with a
 * result event). Escalates to SIGTERM if nothing comes back in time.
 */
export function interruptSession(conversationId: string): boolean {
  const sess = sessions.get(conversationId)
  if (!sess || sess.status !== 'busy') return false
  console.log(`[session] ${conversationId}: interrupt`)
  sess.proc.stdin!.write(
    JSON.stringify({
      type: 'control_request',
      request_id: `req_${randomUUID()}`,
      // cancel_queued: the CLI keeps messages that arrived mid-turn in a queue;
      // without this flag they survive the interrupt and run right after it
      // ("still_queued"), so Stop would be followed by more work. Our Stop
      // button means stop everything. Advertised as
      // `interrupt_cancel_queued_v1` on system/init; older CLIs ignore it.
      request: { subtype: 'interrupt', cancel_queued: true },
    }) + '\n',
  )
  armKillTimer(sess)
  return true
}

export function killSession(conversationId: string): boolean {
  const sess = sessions.get(conversationId)
  if (!sess) return false
  closeSession(sess, { graceful: false })
  return true
}

function closeSession(sess: Session, opts: { graceful: boolean }): void {
  sess.closing = true
  if (opts.graceful) {
    // Closing stdin lets the CLI finish cleanly; SIGTERM is the backstop.
    sess.proc.stdin?.end()
    armKillTimer(sess)
  } else {
    sess.proc.kill('SIGTERM')
  }
}

/** Final teardown: notify subscribers and drop the session. */
function endSession(sess: Session): void {
  if (sessions.get(sess.conversationId) === sess) {
    sessions.delete(sess.conversationId)
  }
  emit(sess, { type: 'end' })
  sess.subscribers.clear()
}

function failSession(sess: Session, message: string): void {
  pushEvent(sess, { type: 'error', message })
  endSession(sess)
}

// ── Idle reaper ──────────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now()
  for (const sess of sessions.values()) {
    if (
      sess.status === 'idle' &&
      !sess.closing &&
      now - sess.lastActivityAt > IDLE_TTL_MS
    ) {
      console.log(`[session] ${sess.conversationId}: idle TTL, closing`)
      closeSession(sess, { graceful: true })
    }
  }
}, 60_000).unref()
