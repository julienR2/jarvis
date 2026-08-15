// Helpers shared by the two process stacks:
//   - legacy one-shot invocations (index.ts) — one `claude -p` per message
//   - persistent sessions (sessions.ts)      — one long-lived process per conversation
// The legacy stack is kept byte-compatible during the migration so an old
// backend keeps working against this engine; it goes away once the backend
// has switched to the session API.

import { readFileSync } from 'fs'

/**
 * Which assistant message an activity event came from.
 *
 * Monotonic per engine process, one value per assistant message. It exists so a
 * reader can tell `note, tool, tool` (one message: the note labels both tools)
 * from `note, tool | tool` (two messages: the note labels only the first) — a
 * distinction the flat event stream cannot otherwise express, and which decides
 * whether a note is really the label of the steps under it.
 *
 * Absent on events from the legacy one-shot stack, which never learned it;
 * consumers must treat a missing group as "unknown", not as group 0.
 */
export type ActivityGroup = number

export type ClaudeEvent =
  | { type: 'thinking' }
  | { type: 'tool'; name: string; group?: ActivityGroup }
  // Prose written for a human reader, as opposed to the mechanical steps `tool`
  // records. Two sources: the main loop narrating what its subagents are up to,
  // and its own summarized reasoning. Persisted like `tool`, but kept a separate
  // type so the UI can show it instead of hiding it behind the step toggle.
  //
  // Notes are deliberately durable. Reasoning was first tried as a live,
  // self-replacing status line and rejected — it flickered past faster than it
  // could be read. If it's worth showing, it's worth keeping.
  | { type: 'note'; text: string; group?: ActivityGroup }
  | { type: 'chunk'; text: string; group?: ActivityGroup }
  // ── Live-only event ────────────────────────────────────────────────────────
  // Emitted straight to subscribers, never pushed to the replay ring buffer and
  // never persisted: it describes a turn *in progress*, and the authoritative
  // record is the `chunk`/`done` pair that follows. A client that misses these
  // (reconnect, cron with nobody watching) loses nothing durable.
  //
  // Partial answer text, as the model writes it. The complete text arrives
  // again in a `chunk` once the block closes — consumers must replace their
  // accumulated deltas with it rather than append, since a partial can be
  // retracted (refusal, stale message_start) and re-issued.
  | { type: 'delta'; text: string }
  // pending: the turn ended but the conversation isn't actually finished —
  // background subagents are still running and a wake-up turn will follow.
  // The backend keeps the thinking indicator on for these.
  | { type: 'done'; result: string; sessionId: string | null; pending?: boolean }
  | { type: 'error'; message: string }
  // How full the model's context is right now. Emitted after every main-loop
  // assistant message, since that's where the CLI reports token counts.
  // contextWindow is null when the window is unknown (unrecognised model, not
  // yet confirmed by a result event) — consumers should show no gauge rather
  // than fall back to a window learned for some earlier model.
  | { type: 'usage'; contextTokens: number; contextWindow: number | null }

export const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR || '/jarvis/agent/workspace'
export const MAX_EVENTS = 1000

// The shared INTERNAL_SECRET is the auth token for this service AND is needed by
// Claude subprocesses to call the backend's /internal/* API. Read it fresh (not
// cached at module load) so that on a cold boot — where the backend generates and
// persists the secret only after the engine has started — the engine picks it up
// as soon as secrets.json appears, without a restart.
export function internalSecret(): string | undefined {
  const env = process.env.INTERNAL_SECRET
  if (env && env !== 'internal') return env
  try {
    const secretsPath =
      process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'
    return JSON.parse(readFileSync(secretsPath, 'utf8')).internal || undefined
  } catch {
    return undefined
  }
}

// Back-fill the Claude OAuth token from the persisted secrets file when it is
// not already in the environment. Read fresh (not cached) so a token saved via
// the onboarding flow is usable immediately, without a container restart.
export function claudeOauthToken(): string | undefined {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
    return process.env.CLAUDE_CODE_OAUTH_TOKEN
  try {
    const secretsPath =
      process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'
    return (
      JSON.parse(readFileSync(secretsPath, 'utf8')).claudeOauthToken ||
      undefined
    )
  } catch {
    return undefined
  }
}
