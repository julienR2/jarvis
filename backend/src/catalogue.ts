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
import { readFileSync } from 'fs'

/**
 * What a model produces, which decides how a message to it is handled.
 *
 * A text model runs the agent through the CLI. A media model is not an agent at
 * all — it is called directly, with the message as the prompt, and answers with
 * a picture or a clip. Treating them the same is what made picking an image
 * model fail silently.
 */
export type ModelKind = 'text' | 'image' | 'video' | 'audio'

export function kindOf(outputs?: string[]): ModelKind {
  if (outputs?.includes('video')) return 'video'
  if (outputs?.includes('image')) return 'image'
  if (outputs?.includes('audio')) return 'audio'
  return 'text'
}

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
  /** What it produces, which decides how a message to it is handled. */
  kind?: ModelKind
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
  // Two requests, because one ordering doesn't fit both halves of the catalogue.
  //
  // output_modalities is an opt-in rather than a filter: the default listing
  // returns only part of what the gateway serves — every video model and most
  // image ones are missing without it.
  //
  // sort=most-popular is real usage data, and worth having for the models it
  // covers. It doesn't cover video: there, most-popular, top-weekly and
  // pricing-low-to-high all return the same alphabetical list, so the sort is
  // being ignored. Sending it anyway would lead with "alibaba/happyhorse-1.0"
  // purely because of the letter a; the gateway's own unsorted order leads with
  // its flagships instead. So video is fetched separately, unsorted.
  const root = cfg.baseUrl.replace(/\/+$/, '')
  const fetchList = async (query: string) => {
    const r = await fetch(`${root}/v1/models?${query}`, {
      headers: cfg.authToken ? { Authorization: `Bearer ${cfg.authToken}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) throw new Error(`gateway returned ${r.status}`)
    return ((await r.json()) as { data?: Array<Record<string, unknown>> }).data ?? []
  }

  const [ranked, video] = await Promise.all([
    fetchList('output_modalities=text,image,audio&sort=most-popular'),
    fetchList('output_modalities=video').catch(() => []),
  ])
  // Ranked first, so the picker's default view leads with the models most
  // people actually use; video keeps its own order behind them.
  const body = { data: [...ranked, ...video] }

  const models: ModelOption[] = (body.data ?? [])
    // Two kinds of model, with different requirements.
    //
    // A text model runs the agent, so it must be able to: call tools (every
    // turn can use Bash, Read, Edit), accept max_tokens (the Messages API
    // requires it), and hold the agent's prompt and skills — the smallest real
    // turn recorded here is ~36k, so a 4k window cannot serve one.
    //
    // A media model runs none of that. It is called directly at /v1/images or
    // /v1/videos with the message as the prompt, so none of those requirements
    // apply and imposing them would hide every image model there is.
    .filter((m) => {
      const arch = (m.architecture ?? {}) as { output_modalities?: string[] }
      if (kindOf(arch.output_modalities) !== 'text') return true
      const params = (m.supported_parameters ?? []) as string[]
      if (!Array.isArray(params)) return false
      if (!params.includes('tools') || !params.includes('max_tokens')) return false
      return Number(m.context_length ?? 0) >= MIN_CONTEXT
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
        kind: kindOf(arch.output_modalities),
      }
    })
    .filter((m) => m.id)

  if (models.length) cache = { at: Date.now(), models }
  return models
}


/** The kind of a model id, resolved from the gateway catalogue. */
export async function modelKind(id?: string | null): Promise<ModelKind> {
  if (!id || !id.includes('/')) return 'text'
  const cfg = gatewayConfig()
  if (!cfg) return 'text'
  try {
    const models = await gatewayModels(cfg)
    return models.find((m) => m.id === id)?.kind ?? 'text'
  } catch {
    return 'text'
  }
}

export { gatewayConfig, gatewayModels, ANTHROPIC_MODELS, readSecretsSafe }
