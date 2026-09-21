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
import { existsSync, readFileSync } from 'fs'
import {
  type ClaudeEvent,
  WORKSPACE_DIR,
  MAX_EVENTS,
  internalSecret,
  providerEnv,
  isGatewayModel,
} from './shared.js'

export type SessionEvent = ClaudeEvent | { type: 'end' }

/**
 * A prompt the CLI parked its turn on, waiting for the person: a question it
 * asked on purpose (AskUserQuestion) or a tool call its permission rules would
 * not decide alone. Answered through answerSession(); until then the turn is
 * suspended and the session counts as busy.
 */
export interface PendingAsk {
  requestId: string
  toolName: string
  toolUseId: string | null
  input: Record<string, unknown>
  askedAt: number
}

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
  // Pass the live-streaming CLI flags on spawn. Cleared and retried once if the
  // CLI rejects them — see the unknown-option branch in the close handler.
  streamingFlags: boolean
  // Route permission prompts to us (`--permission-prompt-tool stdio`) instead
  // of auto-denying them. Same retry treatment as the streaming flags.
  hostPrompts: boolean
  // Prompts the CLI is waiting on, oldest first. Usually empty or one; several
  // when the model called more than one gated tool in the same message.
  pending: PendingAsk[]
  // One-shot sessions (title generation, isolated cron/webhook runs) close
  // stdin after the first result — or after the wake-up turn, when background
  // subagents were still running.
  oneShot: boolean
  // A graceful close was initiated (reap, eviction, model change) — the close
  // handler must not report it as an error.
  closing: boolean
  // Escalation timer armed by interrupt() and graceful closes.
  killTimer: NodeJS.Timeout | null
  stderrTail: string
  // Context window of the model in use, or null while still unknown. Seeded
  // from the model id and confirmed from the result event's modelUsage.
  contextWindow: number | null
  // Last usage figure actually reported, so unchanged ones can be skipped —
  // see recordUsage.
  lastUsage: { tokens: number; window: number | null } | null
}

// Known context windows, matched on the full model id. Anything not listed
// reports null — the CLI fills it in from the result event, which beats
// guessing. Matching by family name alone would be wrong: `opus` and `sonnet`
// span both 1M ids and the 200k 4.5-and-older ids that the picker no longer
// offers but old conversations still carry in their `model` column.
const MODEL_WINDOWS: [RegExp, number][] = [
  [/^claude-(fable|mythos|opus|sonnet)-5$/i, 1_000_000],
  [/^claude-(opus|sonnet)-4-[678]$/i, 1_000_000],
  [/^claude-haiku-4-5/i, 200_000],
]

/**
 * Context window for a model id, or null when we don't recognise it.
 *
 * Seeding this at spawn matters: the CLI only reports the real window on the
 * result event, i.e. AFTER the turn's usage events. Without a seed, every
 * turn-1 reading would carry a placeholder — and since sessions are reaped on
 * idle, conversations that only ever run one turn per session (crons, mail
 * triage) would never get past it. Returning null rather than a default keeps
 * an unknown model from silently reporting against the wrong denominator.
 */
function windowForModel(model?: string): number | null {
  if (!model) return null
  return MODEL_WINDOWS.find(([pattern]) => pattern.test(model))?.[1] ?? null
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
  pending: PendingAsk[]
}> {
  return [...sessions.values()].map((s) => ({
    conversationId: s.conversationId,
    status: s.status,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    model: s.model,
    pending: s.pending,
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
  // Respawn only: the replaced session's subscriber set, adopted by reference
  // so open SSE streams survive the swap (see ensureSession).
  inheritSubscribers?: Set<(ev: SessionEvent) => void>
}

export function ensureSession(opts: EnsureOptions): Session {
  const existing = sessions.get(opts.conversationId)
  if (existing) {
    // Model or effort changed mid-conversation: the flags are argv-only, so
    // the process has to be replaced. Resume from its own live session id.
    // (`effort` is compared as sent: undefined = no flag, 'high' = the flag.)
    if (
      (opts.model ?? existing.model) !== existing.model ||
      opts.effort !== existing.effort
    ) {
      // Crossing between Anthropic and a gateway means the transcript can't be
      // resumed: the CLI references the previous response's message id, and the
      // new provider never issued it — the turn fails with
      // "previous_message_id must be the id from a prior /v1/messages
      // response". Switching provider therefore starts a fresh CLI session.
      // Jarvis keeps its own message history either way, so the conversation is
      // intact on screen; what is lost is the CLI's own context carry-over.
      const crossedProvider =
        isGatewayModel(opts.model ?? existing.model) !== isGatewayModel(existing.model)
      const resumeId = crossedProvider
        ? null
        : existing.claudeSessionId ?? opts.resumeSessionId ?? null
      if (crossedProvider) {
        console.log(
          `[session] ${opts.conversationId}: provider changed, starting a fresh session`,
        )
      }
      console.log(
        `[session] ${opts.conversationId}: model/effort change, respawning`,
      )
      closeSession(existing, { graceful: false })
      // Hand the subscriber SET ITSELF (not a copy) to the replacement. The
      // backend attaches once per conversation and only re-attaches when the
      // stream emits `end` — which a respawn deliberately doesn't, since the
      // conversation lives on. Giving the new session a fresh empty set would
      // strand that subscriber on the dead object and silently drop every
      // event of the turn that triggered the respawn, and of every turn after
      // it. Sharing the reference also keeps the SSE handler's own
      // `subscribers.delete(handler)` cleanup pointing at the live set.
      return createSession({
        ...opts,
        resumeSessionId: resumeId,
        inheritSubscribers: existing.subscribers,
      })
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
    subscribers: opts.inheritSubscribers ?? new Set(),
    model: opts.model,
    effort: opts.effort,
    envVars: opts.envVars,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    unanswered: [],
    allowResumeRetry: true,
    streamingFlags: true,
    hostPrompts: true,
    pending: [],
    oneShot: opts.oneShot ?? false,
    closing: false,
    killTimer: null,
    stderrTail: '',
    contextWindow: windowForModel(opts.model),
    lastUsage: null,
  }
  sessions.set(sess.conversationId, sess)
  spawnProcess(sess, opts.resumeSessionId ?? null)
  return sess
}

/**
 * The provider id of the last real answer in a transcript, or null.
 *
 * Skips the CLI's `<synthetic>` entries — its own "API Error …" / "No response
 * requested" placeholders, which carry a plain uuid and say nothing about who
 * answered. They are also exactly what a wedged conversation accumulates, so
 * reading them would hide the very crossing this looks for.
 */
function lastAnswerId(sessionId: string): string | null {
  const projects = `${process.env.CLAUDE_CONFIG_DIR || '/jarvis/agent'}/projects`
  // The CLI keys a project dir by its cwd with the separators flattened:
  // /jarvis/agent/workspace → -jarvis-agent-workspace.
  const path = `${projects}/${WORKSPACE_DIR.replace(/\//g, '-')}/${sessionId}.jsonl`
  if (!existsSync(path)) return null
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch (err) {
    console.error(`[session] could not read transcript ${path}:`, err)
    return null
  }
  // From the end: the first real assistant message wins, so the scan stops
  // within a few lines on a healthy transcript.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue
    let entry: any
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    const msg = entry?.message
    if (msg?.role !== 'assistant' || !msg.id || msg.model === '<synthetic>') continue
    return String(msg.id)
  }
  return null
}

/**
 * Whether a transcript can be handed to `--resume` while running `model`.
 *
 * The CLI cites the previous answer's message id on the next request
 * (`diagnostics.previous_message_id`), and a provider only accepts ids it
 * issued itself: Anthropic wants `msg_…`, a gateway issues its own shape
 * (`gen-…` on OpenRouter). A transcript whose last answer came from the other
 * side is therefore unresumable — every turn dies with "previous_message_id
 * must be the `id` from a prior /v1/messages response".
 *
 * ensureSession already refuses to resume across a live model switch, but the
 * crossing outlives the process: it is baked into the file on disk. A cold
 * session rebuilt from the backend's stored id resumes it again and wedges the
 * conversation for good — which is what happened to a conversation whose cron
 * ran it on a gateway model back when crons shared the conversation's session.
 * The conversation's own model never changed, so no switch guard could see it.
 * Reading the transcript is the only way to know.
 */
function resumableUnder(sessionId: string, model?: string): boolean {
  const id = lastAnswerId(sessionId)
  // Nothing to cite (fresh or unreadable transcript): let the CLI decide.
  if (!id) return true
  return id.startsWith('msg_') !== isGatewayModel(model)
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

  // Token-level `stream_event`s on top of the complete-message events. Without
  // it the first text of a turn only lands once the model has finished the whole
  // assistant message — i.e. the entire answer for a one-message reply.
  if (sess.streamingFlags) args.push('--include-partial-messages')

  // Permission prompts come to us as `can_use_tool` control requests instead
  // of being denied on the spot, which is how a headless CLI treats an "ask"
  // with nobody to ask. This is what makes AskUserQuestion work at all: the
  // tool is the prompt, and its answers travel back in the control response.
  // It is NOT in --allowedTools on purpose — pre-approving it would skip the
  // prompt and run the tool with no answers. Anything else the permission
  // rules escalate (auto mode's classifier balking at a tool call) now waits
  // for an Approve/Deny too, rather than failing the turn silently.
  if (sess.hostPrompts) args.push('--permission-prompt-tool', 'stdio')

  const mcpConfig = `${process.env.CLAUDE_CONFIG_DIR || '/jarvis/agent'}/mcp.json`
  if (existsSync(mcpConfig)) args.push('--mcp-config', mcpConfig)

  // Drop a resume the current provider would reject (see resumableUnder). The
  // reassignment matters: the retry branches in the `close` handler below close
  // over this parameter, and they must not re-resume it either.
  if (resumeSessionId && !resumableUnder(resumeSessionId, sess.model)) {
    console.warn(
      `[session] ${sess.conversationId}: transcript ${resumeSessionId} was last written by another provider — starting fresh`,
    )
    sess.claudeSessionId = null
    resumeSessionId = null
  }

  if (resumeSessionId) args.push('--resume', resumeSessionId)
  if (sess.model) args.push('--model', sess.model)
  // Effort: the backend sends 'high' when the chat's "Think hard" switch is
  // on, nothing otherwise — no flag, the model's own default. Haiku uses
  // classic extended thinking rather than adaptive effort and errors if
  // --effort is passed, so skip the flag for it.
  if (sess.effort && !/haiku/i.test(sess.model ?? '')) {
    args.push('--effort', sess.effort)
  }
  // No --thinking-display: reasoning summaries were removed (2026-09-21). The
  // API default is `omitted`, so thinking blocks arrive with empty text and
  // the complete-message handler has nothing to surface.

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
        // Provider credentials, resolved fresh per spawn. Which one depends on
        // the model: a namespaced id (openai/gpt-…) goes to the gateway, a bare
        // one to Anthropic. See shared.ts.
        ...providerEnv(sess.model),
        // Before sess.envVars, so a caller can override it. An isolated run
        // (cron/webhook with inherit_context = 0) keys its session by a
        // throwaway `cron-*`/`hook-*` id, but its output lands in a real
        // conversation — and skills build paths and API calls out of this
        // variable (uploads/, apps/, reading the conversation back). Left as
        // the session key it would point at a conversation that never existed.
        JARVIS_CONVERSATION_ID: sess.conversationId,
        ...sess.envVars,
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

    // The CLI rejected one of the streaming flags: retry once without them.
    //
    // `--thinking-display` in particular is accepted by the pinned 2.1.220 but
    // absent from `--help`, i.e. unsupported surface — and the update cron bumps
    // that pin unattended. Without this branch, a rename upstream wouldn't
    // degrade streaming, it would make every session fail to spawn.
    if (
      code !== 0 &&
      sess.streamingFlags &&
      /unknown option .--(include-partial-messages|thinking-display)/.test(
        sess.stderrTail,
      )
    ) {
      console.warn(
        `[session] ${sess.conversationId}: CLI rejected a streaming flag — retrying without live streaming`,
      )
      sess.streamingFlags = false
      spawnProcess(sess, resumeSessionId)
      for (const text of sess.unanswered) writeUserLine(sess, text)
      return
    }

    // Same for the prompt routing flag: hidden from --help, so the least
    // guaranteed of the lot. Without it questions are auto-denied again — a
    // degraded turn, not a dead session.
    if (
      code !== 0 &&
      sess.hostPrompts &&
      /unknown option .--permission-prompt-tool/.test(sess.stderrTail)
    ) {
      console.warn(
        `[session] ${sess.conversationId}: CLI rejected --permission-prompt-tool — retrying without host prompts`,
      )
      sess.hostPrompts = false
      spawnProcess(sess, resumeSessionId)
      for (const text of sess.unanswered) writeUserLine(sess, text)
      return
    }

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

/**
 * Report how full the context is, from an assistant message's usage block.
 *
 * The three input counters are the whole prompt the model just received, split
 * by how it was billed (fresh / cache write / cache read) — so their sum IS the
 * context size at that moment. Deliberately NOT the result event's usage, which
 * aggregates every API call of the turn and would read several times the window
 * on a long tool-heavy turn.
 */
function recordUsage(sess: Session, usage: any): void {
  if (!usage) return
  const contextTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  // Zeros come from messages the CLI produced without a real API call (error
  // paths, local replies) — reporting them would blank the gauge mid-turn.
  if (contextTokens <= 0) return
  // The prompt is unchanged for most messages of a tool loop, so the same figure
  // arrives over and over — measured at 62 usage events, nearly all identical,
  // in a single turn. Each one costs the backend a conversations UPDATE and an
  // SSE frame for a gauge that didn't move, so only report movement.
  const last = sess.lastUsage
  if (last && last.tokens === contextTokens && last.window === sess.contextWindow) {
    return
  }
  sess.lastUsage = { tokens: contextTokens, window: sess.contextWindow }
  pushEvent(sess, {
    type: 'usage',
    contextTokens,
    contextWindow: sess.contextWindow,
  })
}

/**
 * Human-readable label for a tool call, for the activity trail.
 *
 * The generic `Using <ToolName>...` fallback this replaces was near-useless in
 * the UI: "Using Skill..." says nothing about *which* skill, and the tools that
 * hit the fallback (Skill, Task, WebSearch, WebFetch, MCP) are exactly the ones
 * whose input carries the interesting part. Tools that pass an explicit
 * `description` keep it — the model wrote it for a reader.
 */
function toolLabel(name: string, input: any): string {
  if (input?.description) return input.description

  switch (name) {
    case 'Skill':
      return input?.skill ? `Skill: ${input.skill}` : 'Running a skill'
    case 'Task':
      return input?.subagent_type
        ? `Agent: ${input.subagent_type}`
        : 'Delegating to an agent'
    case 'WebSearch':
      return input?.query ? `Searching: ${input.query}` : 'Searching the web'
    case 'WebFetch':
      return input?.url ? `Fetching ${hostOf(input.url)}` : 'Fetching a page'
    case 'TodoWrite':
      return 'Updating the todo list'
  }

  // MCP tools arrive as mcp__<server>__<action> — the raw id is noise, the
  // server and action are not.
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  if (mcp) return `${mcp[1]}: ${mcp[2].replace(/_/g, ' ')}`

  return `Using ${name}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url.slice(0, 60)
  }
}

function attachStdoutParser(sess: Session, proc: ChildProcess): void {
  let buf = ''
  let accumulated = ''
  // Every live background task — subagents AND backgrounded Bash. Keeps the
  // session alive: a wake-up turn is coming, the idle reaper must not kill it,
  // and the backend must re-attach to it after a restart.
  const runningTasks = new Set<string>()
  // Subagent tasks only. While one runs, the main loop's text is narration
  // between agent results ("spawning the verifier now") and reads better as an
  // activity step than as a chat bubble. A backgrounded Bash is different: the
  // main loop is talking straight to the user, so its text stays chat text.
  const narratingTasks = new Set<string>()
  const QUIET_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'])
  // tool_use ids already surfaced as an activity line, so the task_started that
  // follows a backgrounded Bash doesn't announce the same description twice.
  const announcedToolIds = new Set<string>()
  // Which assistant message the activity events being emitted belong to — see
  // ActivityGroup. Keyed off message.id rather than counting events: the CLI
  // emits one `assistant` event PER CONTENT BLOCK, so a message that thinks and
  // then calls two tools arrives as three events sharing one id. Counting
  // events instead would put the reasoning in a different group from the tools
  // it introduces — precisely the pairing this exists to record.
  let activityGroup = 0
  let activityMessageId: string | null = null
  /**
   * Partial-message events (`--include-partial-messages`): one per token.
   *
   * Answer text only. Thinking deltas are ignored — see the --thinking-display
   * note in spawnProcess for why reasoning isn't surfaced.
   *
   * Everything here goes out via emit(), never pushEvent() — these must stay out
   * of the replay ring buffer, which holds MAX_EVENTS and would otherwise be
   * flushed of every real event by a single paragraph of streamed text.
   */
  function handleStreamEvent(ev: any): void {
    // Subagent internals are dropped. The main loop already narrates what its
    // agents are doing (the narratingTasks path below), and that reads far
    // better than raw subagent text. Belt and braces: --forward-subagent-text
    // is off by default, so these normally never arrive at all.
    if (ev.parent_tool_use_id) return
    const inner = ev.event
    if (!inner || inner.type !== 'content_block_delta') return
    const delta = inner.delta

    if (delta?.type === 'text_delta' && delta.text) {
      // Same gate as `chunk`: while subagents run, main-loop text is narration
      // between agent results and belongs in the activity trail, not streamed
      // as answer text.
      if (narratingTasks.size === 0) {
        emit(sess, { type: 'delta', text: delta.text })
      }
    }
  }

  proc.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)

        // Handled before the raw-event log on purpose: at one event per token,
        // logging these would churn the container's 10MB/3-file log rotation in
        // minutes and bury the events worth debugging.
        if (ev.type === 'stream_event') {
          sess.lastActivityAt = Date.now()
          handleStreamEvent(ev)
          continue
        }

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

        // The CLI asking US something: a parked permission prompt or question.
        if (ev.type === 'control_request') {
          handleControlRequest(sess, ev)
          continue
        }
        // …and withdrawing one it no longer needs answered (the turn was
        // interrupted, typically).
        if (ev.type === 'control_cancel_request' && ev.request_id) {
          resolveAsk(sess, String(ev.request_id), 'withdrawn')
          continue
        }

        // Track sub-agent lifecycle for progress detection
        if (ev.type === 'system') {
          if (ev.subtype === 'task_started' && ev.task_id) {
            runningTasks.add(ev.task_id)
            if (ev.task_type !== 'local_bash') narratingTasks.add(ev.task_id)
            const alreadyAnnounced =
              ev.tool_use_id && announcedToolIds.has(ev.tool_use_id)
            if (ev.description && !alreadyAnnounced) {
              console.log('[session] -> agent started:', ev.description)
              // Attributed to the message still being processed: this is the
              // Task tool_use that message just made, arriving by another route.
              pushEvent(sess, {
                type: 'tool',
                name: ev.description,
                group: activityGroup,
              })
            }
          }
          // Any notification means the task reached a terminal state
          // (completed, failed, killed) — a task left in this set keeps the
          // session busy forever, so err on the side of removing.
          if (ev.subtype === 'task_notification' && ev.task_id) {
            runningTasks.delete(ev.task_id)
            narratingTasks.delete(ev.task_id)
          }
        }

        if (ev.type === 'assistant' && ev.message?.content) {
          // No id to group by (shouldn't happen, but the shape isn't ours to
          // guarantee) — treat the event as its own message rather than
          // silently merging it into the previous one.
          const messageId: string | null = ev.message.id ?? null
          if (messageId === null || messageId !== activityMessageId) {
            activityGroup++
            activityMessageId = messageId
          }
          // Any assistant activity means a turn is in flight — covers turns the
          // CLI starts on its own (queued messages, subagent wake-ups).
          markBusy(sess)
          // Subagents carry their own (much smaller) context and stream through
          // here with parent_tool_use_id set — only the main loop's usage says
          // anything about how full THIS conversation is.
          if (!ev.parent_tool_use_id) recordUsage(sess, ev.message.usage)
          for (const block of ev.message.content) {
            // Thinking blocks are not surfaced: reasoning summaries were
            // removed — a chat reads as a conversation, not as a trail of
            // "let me check the skill first".
            if (block.type === 'tool_use') {
              if (QUIET_TOOLS.has(block.name) && !block.input?.description) {
                console.log('[session] -> tool (quiet):', block.name)
              } else {
                const label = toolLabel(block.name, block.input)
                console.log('[session] -> tool:', label)
                if (block.id) announcedToolIds.add(block.id)
                pushEvent(sess, {
                  type: 'tool',
                  name: label,
                  group: activityGroup,
                })
              }
            }
            if (block.type === 'text' && block.text) {
              if (narratingTasks.size > 0) {
                // Progress text while sub-agents run. Not answer text — but not
                // a mechanical step either, so it goes out as `note` and stays
                // visible in the trail rather than collapsing with the tools.
                console.log('[session] -> progress:', block.text.trim().slice(0, 80))
                pushEvent(sess, {
                  type: 'note',
                  text: block.text.trim(),
                  group: activityGroup,
                })
              } else {
                accumulated += block.text
                console.log(
                  '[session] -> chunk:',
                  block.text.slice(0, 80) + (block.text.length > 80 ? '...' : ''),
                )
                pushEvent(sess, {
                  type: 'chunk',
                  text: block.text + '\n',
                  group: activityGroup,
                })
              }
            }
          }
        }

        // Tool result comes as a "user" event with tool_use_result.
        //
        // Deliberately NOT surfaced in the activity trail any more. It used to
        // push `→ <first line of stdout, cut at 120 chars>`, which for anything
        // structured was the opening brace of a JSON blob — pure noise in a list
        // meant to say what Jarvis is doing. The full result is still in the
        // engine's raw `[session event]` log for debugging.
        if (ev.type === 'user' && ev.tool_use_result) {
          pushEvent(sess, { type: 'thinking' })
        }

        if (ev.type === 'result') {
          // modelUsage is keyed by model id and can hold more than one entry
          // (the main loop plus whatever ran side queries). Only the entry for
          // our own model describes THIS conversation's window — when it's
          // missing we keep the spawn-time seed rather than falling back to the
          // other entries, since that would happily overwrite a correct 200k
          // seed with a subagent's 1M window.
          const own = sess.model
            ? (ev.modelUsage ?? {})[sess.model]?.contextWindow
            : undefined
          if (typeof own === 'number' && own > 0) sess.contextWindow = own

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
          // A turn cannot end with a prompt still open; anything left here was
          // abandoned by the CLI without a cancel (an interrupt racing the
          // answer, say). Say so, or the backend keeps a card up for nothing.
          for (const ask of [...sess.pending]) resolveAsk(sess, ask.requestId, 'withdrawn')
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
          // Background subagents mean a wake-up turn is still coming: closing
          // stdin now would strand it. Stay open and close at the result that
          // finally lands with nothing running.
          if (sess.oneShot && runningTasks.size === 0) {
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

// ── Prompts (control protocol) ───────────────────────────────────────────────

/**
 * A `control_request` from the CLI. The one we serve is `can_use_tool`: the
 * turn is parked until someone answers, so record it and tell subscribers.
 * Anything else is refused outright — an unanswered request would hang the
 * turn, and none of the other subtypes (hook callbacks, MCP bridging) apply to
 * a session we started without registering for them.
 */
function handleControlRequest(sess: Session, ev: any): void {
  const requestId = typeof ev.request_id === 'string' ? ev.request_id : null
  const req = ev.request
  if (!requestId || !req) return
  if (req.subtype !== 'can_use_tool') {
    console.warn(`[session] ${sess.conversationId}: refusing control request ${req.subtype}`)
    writeControl(sess, {
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: `unsupported control request: ${req.subtype}` },
    })
    return
  }
  const ask: PendingAsk = {
    requestId,
    toolName: String(req.tool_name ?? 'unknown'),
    toolUseId: typeof req.tool_use_id === 'string' ? req.tool_use_id : null,
    input: req.input && typeof req.input === 'object' ? req.input : {},
    askedAt: Date.now(),
  }
  sess.pending.push(ask)
  markBusy(sess)
  console.log(`[session] ${sess.conversationId}: waiting on ${ask.toolName} (${requestId})`)
  pushEvent(sess, {
    type: 'ask',
    requestId,
    toolName: ask.toolName,
    toolUseId: ask.toolUseId,
    input: ask.input,
  })
}

/** Forget a pending prompt and tell subscribers how it ended. */
function resolveAsk(sess: Session, requestId: string, outcome: 'answered' | 'withdrawn'): boolean {
  const idx = sess.pending.findIndex((a) => a.requestId === requestId)
  if (idx === -1) return false
  sess.pending.splice(idx, 1)
  pushEvent(sess, { type: 'ask_done', requestId, outcome })
  return true
}

function writeControl(sess: Session, frame: object): void {
  sess.proc.stdin!.write(JSON.stringify(frame) + '\n')
}

export type AskAnswer =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }

/**
 * Answer a parked prompt. `allow` lets the tool run — with `updatedInput` in
 * place of what the model sent, which is how AskUserQuestion's answers travel
 * (`{...input, answers}`); `deny` fails the tool call with `message` as the
 * reason the model reads. Returns false when nothing by that id is waiting.
 */
export function answerSession(conversationId: string, requestId: string, answer: AskAnswer): boolean {
  const sess = sessions.get(conversationId)
  if (!sess) return false
  const ask = sess.pending.find((a) => a.requestId === requestId)
  if (!ask) return false
  const response =
    answer.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: answer.updatedInput ?? ask.input }
      : { behavior: 'deny', message: answer.message || 'Denied by the user.' }
  console.log(`[session] ${conversationId}: ${answer.behavior} ${ask.toolName} (${requestId})`)
  writeControl(sess, {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })
  sess.lastActivityAt = Date.now()
  resolveAsk(sess, requestId, 'answered')
  return true
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

/**
 * Close every idle session so the next message respawns it.
 *
 * Used after a config change the CLI only reads at spawn time — installing or
 * enabling a plugin, say. Nothing is lost: the backend keeps the claude session
 * id and the replacement starts with --resume, so the conversation picks up
 * where it left off, now with the new plugin set. Busy sessions are left alone
 * (killing a live turn would strand it) and reported back to the caller.
 */
export function recycleIdleSessions(): { recycled: string[]; busy: string[] } {
  const recycled: string[] = []
  const busy: string[] = []
  for (const sess of sessions.values()) {
    if (sess.closing) continue
    if (sess.status === 'busy') {
      busy.push(sess.conversationId)
      continue
    }
    closeSession(sess, { graceful: true })
    recycled.push(sess.conversationId)
  }
  if (recycled.length || busy.length) {
    console.log(
      `[session] recycled ${recycled.length} idle session(s), skipped ${busy.length} busy`,
    )
  }
  return { recycled, busy }
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
