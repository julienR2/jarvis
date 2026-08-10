// Helpers shared by the two process stacks:
//   - legacy one-shot invocations (index.ts) — one `claude -p` per message
//   - persistent sessions (sessions.ts)      — one long-lived process per conversation
// The legacy stack is kept byte-compatible during the migration so an old
// backend keeps working against this engine; it goes away once the backend
// has switched to the session API.

import { readFileSync } from 'fs'

export type ClaudeEvent =
  | { type: 'thinking' }
  | { type: 'tool'; name: string }
  | { type: 'chunk'; text: string }
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
