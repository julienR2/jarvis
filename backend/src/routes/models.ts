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
import { DEFAULT_MODEL } from '../models.js'

export interface ModelOption {
  id: string
  name: string
  desc: string
  /** Anthropic's effort parameter; gateways don't take it. */
  effort?: boolean
  /** Output modalities the model supports (text, image, audio). */
  outputs?: string[]
}

const ANTHROPIC_MODELS: ModelOption[] = [
  { id: 'claude-fable-5', name: 'Fable 5', desc: 'Most capable, for long-running agents' },
  { id: 'claude-opus-5', name: 'Opus 5', desc: 'Most capable — complex agentic coding & enterprise work' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', desc: 'Best mix of speed and intelligence' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', desc: 'Fastest, near-frontier', effort: false },
]

const SECRETS_PATH = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'

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
    .map((m) => {
      const id = String(m.id ?? '')
      const ctx = Number(m.context_length ?? 0)
      const arch = (m.architecture ?? {}) as { output_modalities?: string[] }
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
      }
    })
    .filter((m) => m.id)

  if (models.length) cache = { at: Date.now(), models }
  return models
}

export async function modelRoutes(app: FastifyInstance) {
  app.get('/api/models', { onRequest: [app.authenticate] }, async () => {
    const cfg = gatewayConfig()
    if (!cfg) {
      return { provider: 'anthropic', models: ANTHROPIC_MODELS, default: DEFAULT_MODEL }
    }
    try {
      const models = await gatewayModels(cfg)
      return {
        provider: 'gateway',
        models,
        default: DEFAULT_MODEL,
        // Gateways serve models we can't enumerate reliably; let the user type
        // an id rather than trapping them in whatever the catalogue returned.
        allowCustom: true,
      }
    } catch (err: any) {
      return {
        provider: 'gateway',
        models: [],
        default: DEFAULT_MODEL,
        allowCustom: true,
        error: `Couldn't list models from the gateway: ${err?.message ?? err}`,
      }
    }
  })
}
