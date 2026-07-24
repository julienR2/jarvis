// HTTP/SSE client for the engine service.
//
// The engine is a separate container that spawns the `claude` CLI so
// that in-flight invocations survive backend restarts. This module exposes the
// same surface the backend used to get from the now-removed claude.ts:
//   - invoke()       → spawn a process (returns invocationId)
//   - streamEvents() → subscribe to an invocation's event stream
//   - invokeAndWait()→ promise-based one-shot (used for title generation)
//   - cancelInvocation() / isRunning() / getRunningInvocation() / listActive()

import type { EffortLevel } from './types.js'
import { config } from './config.js'

// The engine authenticates every request against the shared internal secret
// (it runs arbitrary Claude prompts, so it must reject unknown callers).
const authHeader = (): Record<string, string> => ({
  Authorization: `Bearer ${config.internalSecret}`,
})

export type ClaudeEvent =
  | { type: 'thinking' }
  | { type: 'tool'; name: string }
  | { type: 'chunk'; text: string }
  | { type: 'done'; result: string; sessionId: string | null }
  | { type: 'error'; message: string }

const ENGINE_URL =
  process.env.ENGINE_URL || 'http://engine:3010'

// ── invoke ───────────────────────────────────────────────────────────────────

export interface InvokeOptions {
  prompt: string
  sessionId: string | null
  conversationId: string
  model?: string
  effort?: EffortLevel
  envVars?: Record<string, string>
}

export async function invoke(opts: InvokeOptions): Promise<string> {
  const res = await fetch(`${ENGINE_URL}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(opts),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`engine /invoke failed: ${res.status} ${text}`)
  }
  const data = (await res.json()) as { invocationId: string }
  return data.invocationId
}

// ── streamEvents ─────────────────────────────────────────────────────────────

export interface StreamHandle {
  cancel: () => void
}

export function streamEvents(
  invocationId: string,
  onEvent: (event: ClaudeEvent) => void,
): StreamHandle {
  const controller = new AbortController()
  let closed = false

  ;(async () => {
    try {
      const res = await fetch(
        `${ENGINE_URL}/stream/${invocationId}`,
        { signal: controller.signal, headers: authHeader() },
      )
      if (!res.ok || !res.body) {
        if (!closed) {
          onEvent({
            type: 'error',
            message: `engine /stream failed: ${res.status}`,
          })
        }
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

          // Extract the "data:" field(s)
          const dataLines = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
          if (dataLines.length === 0) continue
          const payload = dataLines.join('\n')

          try {
            const ev = JSON.parse(payload) as ClaudeEvent | { type: 'end' }
            if (ev.type === 'end') {
              closed = true
              controller.abort()
              return
            }
            onEvent(ev)
          } catch {
            // non-JSON frame (heartbeat comments already filtered above), ignore
          }
        }
      }
    } catch (err: any) {
      if (!closed && err.name !== 'AbortError') {
        console.error('[engine client] stream error:', err)
        onEvent({
          type: 'error',
          message: `stream connection lost: ${err.message ?? err}`,
        })
      }
    }
  })()

  return {
    cancel: () => {
      closed = true
      controller.abort()
    },
  }
}

// ── invokeAndWait ────────────────────────────────────────────────────────────

// Promise-based wrapper: invoke and resolve with the final result string.
// Used by generateTitle(). Errors resolve to an empty string to match the
// previous runClaudeOnce() semantics.
export function invokeAndWait(opts: InvokeOptions): Promise<string> {
  return new Promise((resolve) => {
    let accumulated = ''
    invoke(opts)
      .then((invocationId) => {
        streamEvents(invocationId, (ev) => {
          if (ev.type === 'chunk') accumulated += ev.text
          if (ev.type === 'done') resolve(ev.result || accumulated || '')
          if (ev.type === 'error') resolve(accumulated || '')
        })
      })
      .catch((err) => {
        console.error('[engine client] invokeAndWait error:', err)
        resolve('')
      })
  })
}

// ── cancelInvocation ─────────────────────────────────────────────────────────

export async function cancelInvocation(invocationId: string): Promise<void> {
  await fetch(`${ENGINE_URL}/cancel/${invocationId}`, {
    method: 'POST',
    headers: authHeader(),
  }).catch((err) => {
    console.error('[engine client] cancel failed:', err)
  })
}

// ── isRunning / getRunningInvocation ─────────────────────────────────────────

export async function isRunning(conversationId: string): Promise<boolean> {
  const status = await getRunningInvocation(conversationId)
  return status.running
}

export async function getRunningInvocation(
  conversationId: string,
): Promise<
  | { running: true; invocationId: string }
  | { running: false }
> {
  try {
    const res = await fetch(
      `${ENGINE_URL}/running/${conversationId}`,
      { headers: authHeader() },
    )
    if (!res.ok) return { running: false }
    return (await res.json()) as
      | { running: true; invocationId: string }
      | { running: false }
  } catch (err) {
    console.error('[engine client] isRunning failed:', err)
    return { running: false }
  }
}

// ── listActiveInvocations ────────────────────────────────────────────────────

export interface InvocationStatus {
  id: string
  conversationId: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  eventCount: number
}

export async function listActiveInvocations(): Promise<InvocationStatus[]> {
  try {
    const res = await fetch(`${ENGINE_URL}/status`, { headers: authHeader() })
    if (!res.ok) return []
    const data = (await res.json()) as { invocations: InvocationStatus[] }
    return data.invocations
  } catch (err) {
    console.error('[engine client] listActive failed:', err)
    return []
  }
}
