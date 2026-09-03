// Single source of truth for the backend's default models.
//
// The DB stores `null` in a row's `model` column when no model was explicitly
// chosen — that null is the "use the global default" marker. resolveModel()
// turns it into a concrete id at invocation time.
//
// The `update-claude-cli` skill edits these constants automatically when a new
// model generation ships. Nothing else in the backend should hardcode a model id.
import { readFileSync } from 'fs'

export const DEFAULT_MODEL = 'claude-opus-5'

// The gateway's own default, for an instance whose new conversations should
// start on a gateway model. Not an Anthropic id behind `anthropic/`: someone
// running through OpenRouter usually wants that catalogue's own economics, and
// paying Anthropic prices through a middleman by default is a poor greeting.
export const GATEWAY_DEFAULT_MODEL = 'google/gemini-3.8-flash'

// Model used by subagents (Task tool fan-outs: searches, email triage, …).
// They do scoped, disposable work, so a cheaper tier than the main loop is
// fine. Applied via the CLAUDE_CODE_SUBAGENT_MODEL env var at spawn time;
// agents whose definition pins an explicit model still win over this default.
export const SUBAGENT_MODEL = 'claude-sonnet-5'

// The same models reached through a gateway. A namespaced id routes to the
// gateway (see the engine's providerEnv), so these are what the defaults have
// to become on an instance that has no Claude subscription — otherwise the
// default resolves to a bare id, is sent to Anthropic directly, and fails
// against an OAuth token that was never configured.
const GATEWAY_PREFIX = 'anthropic/'

const SECRETS_PATH = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'

function secrets(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Whether this instance can talk to Anthropic directly.
 *
 * Read per call rather than cached: credentials are changed from the UI, and a
 * default that only corrected itself on restart would be the exact class of bug
 * the connection settings exist to fix.
 */
function hasAnthropicCredential(): boolean {
  return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || secrets().claudeOauthToken)
}

function hasGateway(): boolean {
  const s = secrets()
  return !!(
    (s.providerBaseUrl || process.env.ANTHROPIC_BASE_URL) &&
    (s.providerAuthToken || process.env.ANTHROPIC_AUTH_TOKEN)
  )
}

export type Provider = 'anthropic' | 'gateway'

/** What each provider starts on when the owner hasn't chosen. */
const BUILTIN_DEFAULT: Record<Provider, string> = {
  anthropic: DEFAULT_MODEL,
  gateway: GATEWAY_DEFAULT_MODEL,
}

/**
 * Which provider new conversations belong to.
 *
 * With one configured there is nothing to decide. With both it is the owner's
 * call, and until they make it Claude wins: an OAuth subscription is already
 * paid for, so spending gateway credit by default would be a surprise on the
 * bill rather than a preference.
 */
export function defaultProvider(): Provider {
  const anthropic = hasAnthropicCredential()
  const gateway = hasGateway()
  if (anthropic && gateway) {
    return secrets().defaultProvider === 'gateway' ? 'gateway' : 'anthropic'
  }
  if (gateway && !anthropic) return 'gateway'
  return 'anthropic'
}

/** The model one provider starts new conversations on. */
export function defaultModelFor(provider: Provider): string {
  const stored = secrets()[
    provider === 'gateway' ? 'defaultModelGateway' : 'defaultModelAnthropic'
  ]
  if (typeof stored === 'string' && stored.trim()) return stored.trim()
  return BUILTIN_DEFAULT[provider]
}

/** The default for this instance, given its providers and the owner's choice. */
export function defaultModel(): string {
  return defaultModelFor(defaultProvider())
}

/**
 * The subagent model for a turn, matching the route that turn is taking.
 *
 * It follows the conversation's model, not the instance's configuration: with
 * both providers set up, a conversation on a gateway model would otherwise
 * spawn subagents on a bare Anthropic id, which the gateway has no reason to
 * recognise — the fan-out fails while the main loop looks fine.
 */
export function defaultSubagentModel(model?: string | null): string {
  if (model) return model.includes('/') ? GATEWAY_PREFIX + SUBAGENT_MODEL : SUBAGENT_MODEL
  // No model on the row means the instance default, so follow the same choice
  // it would make — otherwise a gateway-by-default instance fans out onto bare
  // Anthropic ids the gateway has no reason to recognise.
  return defaultProvider() === 'gateway' ? GATEWAY_PREFIX + SUBAGENT_MODEL : SUBAGENT_MODEL
}

/** Resolve a stored/optional model id, falling back to the instance default. */
export function resolveModel(model?: string | null): string {
  return model ?? defaultModel()
}
