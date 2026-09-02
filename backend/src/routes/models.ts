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
  /** Sort key; lower is more prominent. Gateway catalogues only. */
  rank?: number
}

const ANTHROPIC_MODELS: ModelOption[] = [
  { id: 'claude-fable-5', name: 'Fable 5', desc: 'Most capable, for long-running agents' },
  { id: 'claude-opus-5', name: 'Opus 5', desc: 'Most capable — complex agentic coding & enterprise work' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', desc: 'Best mix of speed and intelligence' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', desc: 'Fastest, near-frontier', effort: false },
]

/**
 * Rough popularity order for a gateway catalogue.
 *
 * OpenRouter serves hundreds of models and exposes no popularity signal — its
 * `order` parameter is accepted and ignored, and the payload carries no usage
 * data — so this is a judgement call rather than a measurement: the families
 * people actually reach for, best-known first. Anything unlisted sorts after
 * them, newest first, which is the most useful fallback for a model nobody has
 * heard of yet.
 *
 * It only decides what the picker shows before you type. Search reaches
 * everything.
 */
const POPULAR_FAMILIES = [
  'anthropic/claude',
  'openai/gpt',
  'openai/o',
  'google/gemini',
  'x-ai/grok',
  'deepseek/',
  'meta-llama/',
  'mistralai/',
  'qwen/',
  'amazon/nova',
  'cohere/',
]

function popularityRank(id: string, created: number): number {
  const family = POPULAR_FAMILIES.findIndex((f) => id.startsWith(f))
  // Suffixed variants (:batch, :free, :thinking) are the same model in a
  // narrower shape — keep them below the plain one rather than letting them
  // take a slot in a four-model list.
  const variant = id.includes(':') ? 1 : 0
  if (family === -1) {
    // Unknown families: newest first, all of them after the known ones.
    return 1_000_000 - Math.min(created, 999_999)
  }
  return family * 10 + variant
}

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
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/models`
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
      return {
        id,
        name: String(m.name ?? id),
        desc: ctx ? `${Math.round(ctx / 1000)}k context` : '',
        // Effort is an Anthropic-native parameter; passing it to a gateway
        // model is at best ignored and at worst a 400.
        effort: false,
        rank: popularityRank(id, Number(m.created ?? 0)),
      }
    })
    .filter((m) => m.id)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))

  // Lead with the best of each family rather than the top of one.
  //
  // Straight popularity order fills the whole visible list with Claude
  // variants, which is a strange thing to show someone who just pointed Jarvis
  // at a gateway precisely to reach other providers. So the front of the list
  // is one model per family, and the rest follows in rank order.
  const leadIds = new Set<string>()
  const seenProviders = new Set<string>()
  const lead: ModelOption[] = []
  for (const family of POPULAR_FAMILIES) {
    const best = models.find((m) => m.id.startsWith(family) && !m.id.includes(':'))
    if (!best) continue
    // One per provider, not per model line: OpenAI's gpt-* and o* are separate
    // families but the same vendor, and letting both in costs a slot that a
    // different provider should have.
    const provider = best.id.split('/')[0]
    if (seenProviders.has(provider)) continue
    seenProviders.add(provider)
    lead.push(best)
    leadIds.add(best.id)
  }
  const ranked = [...lead, ...models.filter((m) => !leadIds.has(m.id))]

  if (ranked.length) cache = { at: Date.now(), models: ranked }
  return ranked
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
