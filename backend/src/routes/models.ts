/**
 * The model list the picker offers.
 *
 * It used to be hardcoded in the frontend, which meant the only way to offer a
 * different model was to edit a constant and rebuild — untenable once Jarvis can
 * point at a gateway serving hundreds of them.
 *
 * On Anthropic it returns the curated built-in list. On a gateway it asks the
 * gateway what it serves, so switching provider changes the picker with no
 * restart and no rebuild.
 */
import type { FastifyInstance } from 'fastify'
import { readFileSync } from 'fs'
import { defaultModel } from '../models.js'

export interface ModelOption {
  id: string
  name: string
  desc: string
  /** Anthropic's effort parameter; gateways don't take it. */
  effort?: boolean
  /** Output modalities the model supports (text, image, audio). */
  outputs?: string[]
  /** Input modalities the model accepts (text, file, image, video, audio). */
  inputs?: string[]
}

const ANTHROPIC_MODELS: ModelOption[] = [
  { id: 'claude-fable-5', name: 'Fable 5', desc: 'Most capable, for long-running agents' },
  { id: 'claude-opus-5', name: 'Opus 5', desc: 'Most capable — complex agentic coding & enterprise work' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', desc: 'Best mix of speed and intelligence' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', desc: 'Fastest, near-frontier', effort: false },
]

/** Below this a model cannot hold one Jarvis turn. See the filter below. */
const MIN_CONTEXT = 32_000

const SECRETS_PATH = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'

function readSecretsSafe(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function gatewayConfig(): { baseUrl: string; authToken: string } | null {
  try {
    const s = JSON.parse(readFileSync(SECRETS_PATH, 'utf8'))
    const baseUrl = s.providerBaseUrl || process.env.ANTHROPIC_BASE_URL
    if (!baseUrl) return null
    return { baseUrl, authToken: s.providerAuthToken || process.env.ANTHROPIC_AUTH_TOKEN || '' }
  } catch {
    return null
  }
}

// The catalogue is large and changes slowly; refetching it per keystroke of the
// picker would be silly.
let cache: { at: number; models: ModelOption[] } | null = null
const CACHE_MS = 10 * 60 * 1000

async function gatewayModels(
  cfg: { baseUrl: string; authToken: string },
): Promise<ModelOption[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.models

  // OpenRouter-compatible catalogue endpoint. The base URL is the Anthropic
  // -compatible root (…/api), and the catalogue lives one level down at /v1.
  //
  // sort=most-popular is real usage data from the gateway, which beats any
  // ordering guessed here. Gateways that don't understand it ignore it and
  // return their default order, so it is safe to send unconditionally.
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/models?sort=most-popular`
  const res = await fetch(url, {
    headers: cfg.authToken ? { Authorization: `Bearer ${cfg.authToken}` } : {},
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`gateway returned ${res.status}`)

  const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
  const models: ModelOption[] = (body.data ?? [])
    // Only models that can actually drive Jarvis.
    //
    // Offering one that can't means handing the user a model that fails on its
    // first message with "There's an issue with the selected model" — which
    // reads like a broken instance rather than a model that was never a
    // candidate. Three requirements, each from a real failure mode:
    //
    //  - tools: every turn can call Bash, Read, Edit or an MCP server. A model
    //    without tool calling cannot run the agent at all. Image-generation
    //    models are the common case.
    //  - max_tokens: required by the Messages API the CLI speaks.
    //  - context: the agent's own prompt, rules and skills are large. The
    //    smallest context this instance has ever recorded for a real turn is
    //    ~36k, so anything under 32k cannot hold even one.
    //  - text-only output: an image or audio model runs, reasons, emits its
    //    picture — and Jarvis shows nothing, because the CLI is a text agent
    //    and a turn's result is text. Observed: gemini-3-pro-image thought its
    //    way through a pixel-art scene and returned "(no response)". Generating
    //    an image is a tool the agent calls, not a model it runs on.
    .filter((m) => {
      const params = (m.supported_parameters ?? []) as string[]
      if (!Array.isArray(params)) return false
      if (!params.includes('tools') || !params.includes('max_tokens')) return false
      if (Number(m.context_length ?? 0) < MIN_CONTEXT) return false
      const arch = (m.architecture ?? {}) as { output_modalities?: string[] }
      const outs = arch.output_modalities ?? ['text']
      return outs.every((o) => o === 'text')
    })
    .map((m) => {
      const id = String(m.id ?? '')
      const ctx = Number(m.context_length ?? 0)
      const arch = (m.architecture ?? {}) as {
        output_modalities?: string[]
        input_modalities?: string[]
      }
      return {
        id,
        name: String(m.name ?? id),
        desc: ctx ? `${Math.round(ctx / 1000)}k context` : '',
        // Effort is an Anthropic-native parameter; passing it to a gateway
        // model is at best ignored and at worst a 400.
        effort: false,
        // What the model can emit. Nearly everything is text; image and audio
        // are the rare ones worth filtering for.
        outputs: arch.output_modalities?.length ? arch.output_modalities : ['text'],
        // What it accepts. Richer than the output side (file, image, video,
        // audio) and the more useful filter in practice — "can this read a
        // screenshot" is asked far more often than "can it draw one".
        inputs: arch.input_modalities?.length ? arch.input_modalities : ['text'],
      }
    })
    .filter((m) => m.id)

  if (models.length) cache = { at: Date.now(), models }
  return models
}

export async function modelRoutes(app: FastifyInstance) {
  app.get('/api/models', { onRequest: [app.authenticate] }, async () => {
    const secrets = readSecretsSafe()
    const hasAnthropic = !!(secrets.claudeOauthToken || process.env.CLAUDE_CODE_OAUTH_TOKEN)
    const cfg = gatewayConfig()

    // Both catalogues when both are configured. They are distinguishable by id
    // shape — Anthropic's are bare, a gateway's are namespaced — which is the
    // same rule the engine uses to decide where to send a turn, so what the
    // picker offers and what actually runs can't disagree.
    const anthropic = hasAnthropic ? ANTHROPIC_MODELS : []
    let gateway: ModelOption[] = []
    let error: string | undefined

    if (cfg) {
      try {
        gateway = await gatewayModels(cfg)
      } catch (err: any) {
        error = `Couldn't list models from the gateway: ${err?.message ?? err}`
      }
    }

    return {
      // Kept for callers that just want to know what is available at all.
      provider: gateway.length && anthropic.length
        ? 'both'
        : gateway.length
          ? 'gateway'
          : 'anthropic',
      anthropic,
      gateway,
      gatewayBaseUrl: cfg?.baseUrl ?? '',
      // Flat list of everything selectable, for lookups by id.
      models: [...anthropic, ...gateway],
      // Follows the configured providers, so a gateway-only instance
      // defaults to the gateway's route rather than a bare id it can't reach.
      default: defaultModel(),
      allowCustom: !!cfg,
      error,
    }
  })
}
