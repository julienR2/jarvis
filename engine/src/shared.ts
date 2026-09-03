// Helpers shared by the two process stacks:
//   - legacy one-shot invocations (index.ts) — one `claude -p` per message
//   - persistent sessions (sessions.ts)      — one long-lived process per conversation
// The legacy stack is kept byte-compatible during the migration so an old
// backend keeps working against this engine; it goes away once the backend
// has switched to the session API.

import { readFileSync } from 'fs'
import { timingSafeEqual } from 'crypto'

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

// Provider config: which Anthropic-compatible endpoint the CLI talks to.
// Stored in secrets.json and read fresh on every spawn (never cached), so
// switching provider from the UI applies to the next turn with no restart.
//
// `baseUrl` unset  → Anthropic direct, authenticated with the OAuth token.
// `baseUrl` set    → a gateway (OpenRouter, LiteLLM, a proxy). The OAuth token
//                    is deliberately withheld in that case: it is an Anthropic
//                    credential and must not be sent to a third-party host.
export interface ProviderConfig {
  baseUrl?: string
  authToken?: string
}

export function providerConfig(): ProviderConfig {
  try {
    const secretsPath =
      process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'
    const s = JSON.parse(readFileSync(secretsPath, 'utf8'))
    const baseUrl = s.providerBaseUrl || process.env.ANTHROPIC_BASE_URL
    const authToken = s.providerAuthToken || process.env.ANTHROPIC_AUTH_TOKEN
    return { baseUrl: baseUrl || undefined, authToken: authToken || undefined }
  } catch {
    return {
      baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
      authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
    }
  }
}

/**
 * Whether a model id belongs to a gateway rather than Anthropic directly.
 *
 * Gateways namespace every model by vendor — `openai/gpt-5.6`,
 * `anthropic/claude-opus-5` — while Anthropic's own ids never contain a slash.
 * That shape is the discriminator, which is what lets both credentials be
 * configured at once and the chosen model decide where the turn is sent.
 */
export function isGatewayModel(model?: string | null): boolean {
  return !!model && model.includes('/')
}

// The credential env for a claude spawn, given the model being run. Callers
// spread this over the child env; keys set to '' are cleared rather than
// inherited, so a stale value in the engine's own environment can't leak into
// a gateway request.
//
// Both credentials may be configured. The model decides: a namespaced id goes
// to the gateway, a bare one to Anthropic — so a conversation on GPT and one on
// Claude can run side by side on the same instance.
/**
 * The model each of Claude Code's internal roles resolves to on a gateway.
 *
 * The CLI doesn't only run the model you picked: it reaches for a role — opus,
 * sonnet, haiku — for its own work, like summarising or a cheap subagent. Left
 * unmapped those resolve to bare Anthropic ids, which a gateway has no reason
 * to recognise. OpenRouter publishes `~`-prefixed aliases that track the latest
 * of each line, which is what its Claude Code guide recommends pinning to.
 */
const GATEWAY_ROLE_MODELS: Record<string, string> = {
  ANTHROPIC_DEFAULT_FABLE_MODEL: '~anthropic/claude-fable-latest',
  ANTHROPIC_DEFAULT_OPUS_MODEL: '~anthropic/claude-opus-latest',
  ANTHROPIC_DEFAULT_SONNET_MODEL: '~anthropic/claude-sonnet-latest',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: '~anthropic/claude-haiku-latest',
}

/**
 * Credentials the agent's own tools need, as opposed to the CLI's.
 *
 * The gateway key is useful to skills regardless of which model the
 * conversation runs on: generating an image is an HTTP call to OpenRouter's
 * /v1/images, and wanting one while chatting to Claude is entirely normal. So
 * this is set whenever a key exists, not only on gateway turns.
 */
function agentCredentials(): Record<string, string> {
  const { baseUrl, authToken } = providerConfig()
  // Match the host, not the whole URL: an anchored pattern never fires against
  // "https://openrouter.ai/api", because the character before the host is a
  // slash from the scheme.
  let host = ''
  try {
    host = baseUrl ? new URL(baseUrl).hostname : ''
  } catch {
    host = ''
  }
  const isOpenRouter = host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
  return isOpenRouter && authToken
    ? { OPENROUTER_API_KEY: authToken }
    : { OPENROUTER_API_KEY: '' }
}

export function providerEnv(model?: string | null): Record<string, string> {
  const { baseUrl, authToken } = providerConfig()
  if (baseUrl && isGatewayModel(model)) {
    return {
      ANTHROPIC_BASE_URL: baseUrl,
      ...(authToken ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
      // Blanked, not set to the key. OpenRouter's guide is explicit: the token
      // goes in ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY must be empty, or
      // the two conflict.
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ...GATEWAY_ROLE_MODELS,
      ...agentCredentials(),
    }
  }
  const oauth = claudeOauthToken()
  return {
    ...(oauth ? { CLAUDE_CODE_OAUTH_TOKEN: oauth } : {}),
    ANTHROPIC_BASE_URL: '',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_API_KEY: '',
    // Cleared so a gateway's role pins can't follow a conversation back to the
    // Anthropic route, where those ids mean nothing.
    ...Object.fromEntries(Object.keys(GATEWAY_ROLE_MODELS).map((k) => [k, ''])),
    ...agentCredentials(),
  }
}

// Constant-time comparison for the Bearer secret check.
export function secureEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
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
