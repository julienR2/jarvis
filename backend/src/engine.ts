// HTTP/SSE client for the engine service — session API.
//
// The engine is a separate container that keeps one persistent `claude`
// process per conversation and feeds it user messages over stdin, so:
//   - sendMessage() never refuses a busy conversation — mid-turn messages are
//     steered/queued by the CLI itself
//   - streamConversation() spans turns; it ends only when the session closes
//   - interruptConversation() is a soft cancel (control protocol), the session
//     and its warm context survive

import type { EffortLevel } from './types.js'
import { config } from './config.js'
import { SUBAGENT_MODEL } from './models.js'

// The engine authenticates every request against the shared internal secret
// (it runs arbitrary Claude prompts, so it must reject unknown callers).
const authHeader = (): Record<string, string> => ({
  Authorization: `Bearer ${config.internalSecret}`,
})

export type ClaudeEvent =
  | { type: 'thinking' }
  | { type: 'tool'; name: string; group?: number }
  // Main-loop narration and summarized reasoning — persisted, but shown rather
  // than collapsed with the tool steps. See the engine's shared.ts.
  | { type: 'note'; text: string; group?: number }
  | { type: 'chunk'; text: string; group?: number }
  // Live-only, never persisted: partial answer text for a turn in progress.
  // Forwarded to SSE and dropped at the turn boundary — the `chunk`/`done` pair
  // is the durable record. See shared.ts in the engine for the full contract.
  | { type: 'delta'; text: string }
  // pending: the turn ended but background subagents are still running — a
  // wake-up turn will follow, so the conversation isn't actually finished.
  | { type: 'done'; result: string; sessionId: string | null; pending?: boolean }
  | { type: 'error'; message: string }
  // Context fill after a main-loop assistant message, for the top-bar gauge.
  // contextWindow is null when the engine doesn't know it — stored and shown
  // as-is, never backfilled from a previous model's value.
  | { type: 'usage'; contextTokens: number; contextWindow: number | null }

const ENGINE_URL = process.env.ENGINE_URL || 'http://engine:3010'

// ── sendMessage ──────────────────────────────────────────────────────────────

export interface SendMessageOptions {
  prompt: string
  sessionId: string | null
  conversationId: string
  model?: string
  effort?: EffortLevel
  envVars?: Record<string, string>
  // One-shot sessions (title generation) close after the first result instead
  // of lingering until the idle reaper gets them.
  oneShot?: boolean
}

/**
 * Feed a user message into the conversation's persistent session (the engine
 * spawns it on first use). Returns whether the session was already busy — in
 * that case the message was steered/queued into the running turn.
 */
export async function sendMessage(
  opts: SendMessageOptions,
): Promise<{ queued: boolean }> {
  // Subagents run on a cheaper model than the main loop (see models.ts). The
  // engine forwards envVars into the claude process environment.
  const body = {
    ...opts,
    envVars: { CLAUDE_CODE_SUBAGENT_MODEL: SUBAGENT_MODEL, ...opts.envVars },
  }
  const res = await fetch(`${ENGINE_URL}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`engine /message failed: ${res.status} ${text}`)
  }
  return (await res.json()) as { queued: boolean }
}

// ── streamConversation ───────────────────────────────────────────────────────

export interface StreamHandle {
  cancel: () => void
}

/**
 * Subscribe to a conversation's event stream (current-turn replay + live).
 * `onEnd` fires when the stream terminates server-side — session closed
 * (idle reap, process exit) or, for a legacy invocation, turn finished —
 * NOT on every done event. The caller should drop its attach guard there.
 */
export function streamConversation(
  conversationId: string,
  onEvent: (event: ClaudeEvent) => void,
  onEnd?: () => void,
): StreamHandle {
  const controller = new AbortController()
  let closed = false

  const finish = () => {
    if (closed) return
    closed = true
    controller.abort()
    onEnd?.()
  }

  ;(async () => {
    try {
      const res = await fetch(`${ENGINE_URL}/stream/${conversationId}`, {
        signal: controller.signal,
        headers: authHeader(),
      })
      if (!res.ok || !res.body) {
        if (!closed) {
          onEvent({ type: 'error', message: `engine /stream failed: ${res.status}` })
        }
        finish()
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line
        let idx: number
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)

          const dataLines = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
          if (dataLines.length === 0) continue
          const payload = dataLines.join('\n')

          try {
            const ev = JSON.parse(payload) as ClaudeEvent | { type: 'end' }
            if (ev.type === 'end') {
              finish()
              return
            }
            onEvent(ev)
          } catch {
            // non-JSON frame (heartbeat comments already filtered above), ignore
          }
        }
      }
      finish()
    } catch (err: any) {
      if (!closed && err.name !== 'AbortError') {
        console.error('[engine client] stream error:', err)
        onEvent({
          type: 'error',
          message: `stream connection lost: ${err.message ?? err}`,
        })
      }
      finish()
    }
  })()

  return { cancel: finish }
}

// ── invokeAndWait ────────────────────────────────────────────────────────────

// Promise-based one-shot: send a message and resolve with the final result
// string. Used by generateTitle() with a synthetic conversationId, so its
// short-lived session never collides with the real conversation's. Errors
// resolve to an empty string.
export function invokeAndWait(opts: SendMessageOptions): Promise<string> {
  return new Promise((resolve) => {
    let accumulated = ''
    let settled = false
    const settle = (value: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    sendMessage({ ...opts, oneShot: true })
      .then(() => {
        const handle = streamConversation(
          opts.conversationId,
          (ev) => {
            if (ev.type === 'chunk') accumulated += ev.text
            if (ev.type === 'done') {
              settle(ev.result || accumulated || '')
              handle.cancel()
            }
            if (ev.type === 'error') {
              settle(accumulated || '')
              handle.cancel()
            }
          },
          () => settle(accumulated || ''),
        )
      })
      .catch((err) => {
        console.error('[engine client] invokeAndWait error:', err)
        settle('')
      })
  })
}

// ── interrupt ────────────────────────────────────────────────────────────────

/**
 * Stop the conversation's current work. On a session this is a soft interrupt
 * (context survives, next message continues warm); on a legacy invocation the
 * engine SIGTERMs the process. Both are behind the same endpoint.
 */
export async function interruptConversation(conversationId: string): Promise<void> {
  await fetch(`${ENGINE_URL}/cancel/${conversationId}`, {
    method: 'POST',
    headers: authHeader(),
  }).catch((err) => {
    console.error('[engine client] interrupt failed:', err)
  })
}

// ── isRunning / status ───────────────────────────────────────────────────────

export async function isRunning(conversationId: string): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/running/${conversationId}`, {
      headers: authHeader(),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { running: boolean }
    return data.running
  } catch (err) {
    console.error('[engine client] isRunning failed:', err)
    return false
  }
}

/**
 * Conversation-level busy view for the restart-reconnect path. Covers both
 * stacks: persistent sessions and any legacy invocation still in flight.
 */
// ── Plugins ──────────────────────────────────────────────────────────────────

/**
 * Pass a plugin/marketplace call through to the engine, which owns the `claude`
 * binary and the config dir the CLI writes to. Errors come back as the CLI's
 * own message so the settings page can show it verbatim.
 */
export async function pluginRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${ENGINE_URL}/plugins${path}`, {
    method,
    headers: {
      ...authHeader(),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok) {
    const err = new Error(data?.error ?? `Engine returned ${res.status}`)
    ;(err as any).statusCode = res.status
    throw err
  }
  return data as T
}

/**
 * Ask the engine to actually run `claude` with a candidate credential set.
 * Format checks can't tell a valid token from an expired one — only a real
 * round-trip can, and that is exactly the failure that otherwise bricks an
 * instance with no way to correct it from the UI.
 */
export async function verifyConnection(body: {
  baseUrl?: string
  authToken?: string
  oauthToken?: string
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${ENGINE_URL}/verify-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return { ok: false, error: `engine returned ${res.status}` }
    }
    return (await res.json()) as { ok: boolean; error?: string }
  } catch (err: any) {
    return { ok: false, error: `could not reach engine: ${err?.message ?? err}` }
  }
}

/**
 * Close idle sessions so the next turn picks up changed provider config. Busy
 * conversations keep their current process (and old config) until their turn
 * ends; they come back in `busy` so the UI can say so.
 */
export async function recycleSessions(): Promise<{ recycled: string[]; busy: string[] }> {
  try {
    const res = await fetch(`${ENGINE_URL}/recycle`, {
      method: 'POST',
      headers: authHeader(),
    })
    if (!res.ok) return { recycled: [], busy: [] }
    return (await res.json()) as { recycled: string[]; busy: string[] }
  } catch (err) {
    console.error('[engine client] recycle failed:', err)
    return { recycled: [], busy: [] }
  }
}

export async function listBusyConversations(): Promise<string[]> {
  try {
    const res = await fetch(`${ENGINE_URL}/status`, { headers: authHeader() })
    if (!res.ok) return []
    const data = (await res.json()) as {
      conversations?: Array<{ conversationId: string; busy: boolean }>
    }
    return (data.conversations ?? [])
      .filter((c) => c.busy)
      .map((c) => c.conversationId)
  } catch (err) {
    console.error('[engine client] listBusyConversations failed:', err)
    return []
  }
}
