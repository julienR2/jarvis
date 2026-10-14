/**
 * One (withone.ai) — managed connectors, alongside Jarvis's own.
 *
 * A Jarvis connector is a set of credentials Jarvis stores and the agent reads.
 * A One connection is the opposite: the credential never leaves One. The person
 * signs in to the app on One's site (OAuth handled there), and the agent acts
 * through One's MCP server, which the engine adds to every session while a key
 * is set (engine/src/shared.ts, `oneMcpServer`).
 *
 * Self-contained on purpose: everything One-specific lives here, in
 * routes/one.ts and in the engine's `oneMcpServer`. Removing the key — or
 * switching it off — unplugs it without touching anything else.
 *
 * State is two entries in secrets.json: `oneApiKey` and `oneEnabled`.
 */
import { readFileSync, writeFileSync } from 'fs'

const SECRETS_PATH = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'
const API_BASE = 'https://api.withone.ai/v1'

function readSecrets(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeSecrets(secrets: Record<string, unknown>): void {
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 })
}

export interface OneSettings {
  key: string | null
  /** Off keeps the key but hides One from the agent. Defaults to on. */
  enabled: boolean
}

export function oneSettings(): OneSettings {
  const s = readSecrets()
  const key = typeof s.oneApiKey === 'string' && s.oneApiKey ? s.oneApiKey : null
  return { key, enabled: s.oneEnabled !== false }
}

export function saveOneSettings(patch: { key?: string | null; enabled?: boolean }): void {
  const s = readSecrets()
  if (patch.key !== undefined) {
    if (patch.key) s.oneApiKey = patch.key
    else delete s.oneApiKey
  }
  if (patch.enabled !== undefined) s.oneEnabled = patch.enabled
  writeSecrets(s)
}

/** Whether the agent should see One right now. */
export function oneActive(): boolean {
  const { key, enabled } = oneSettings()
  return !!key && enabled
}

/** `sk_test_…` keys live in One's sandbox; anything else is live. */
export function oneEnvironment(key: string): 'test' | 'live' {
  return key.startsWith('sk_test') ? 'test' : 'live'
}

export class OneError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function oneFetch<T>(path: string, init: { method?: string; key?: string } = {}): Promise<T> {
  const key = init.key ?? oneSettings().key
  if (!key) throw new OneError('No One API key configured', 400)
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'x-one-secret': key },
    signal: AbortSignal.timeout(15_000),
  })
  // Not 401: the browser reads a 401 from Jarvis as its own session expiring.
  if (res.status === 401 || res.status === 403) throw new OneError('One rejected the API key', 400)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new OneError(`One API ${res.status}: ${text.slice(0, 200) || res.statusText}`, 502)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

interface Page<T> { rows: T[]; total: number; pages: number; page: number }

// ── Connections ──────────────────────────────────────────────────────────────

/** The fields of a One connection worth showing. Shaped close to a Jarvis connector. */
export interface OneConnection {
  id: string
  /** What the agent passes to One's tools to act through this connection. */
  key: string
  platform: string
  name: string
  description: string
  image: string
  state: 'operational' | 'degraded' | 'failed' | 'unknown'
  /** Which account it is, when One knows (an email, a workspace name…). */
  identity: string | null
  tags: string[]
}

interface VaultConnection {
  id: string
  key: string
  platform: string
  name?: string | null
  title?: string | null
  description?: string
  image?: string
  state: OneConnection['state']
  identity?: string | null
  tags?: string[]
}

export async function listOneConnections(key?: string): Promise<OneConnection[]> {
  const rows: VaultConnection[] = []
  for (let page = 1; page <= 20; page++) {
    const res = await oneFetch<Page<VaultConnection>>(`/vault/connections?page=${page}&limit=100`, { key })
    rows.push(...res.rows)
    if (page >= res.pages || res.rows.length === 0) break
  }
  return rows.map((c) => ({
    id: c.id,
    key: c.key,
    platform: c.platform,
    name: c.title || c.name || c.platform,
    description: c.description ?? '',
    image: c.image ?? '',
    state: c.state,
    identity: c.identity ?? null,
    tags: c.tags ?? [],
  }))
}

export async function deleteOneConnection(id: string): Promise<void> {
  await oneFetch(`/vault/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── Catalogue ────────────────────────────────────────────────────────────────

/** A platform One can connect to. Public — no key needed to list them. */
export interface OnePlatform {
  platform: string
  name: string
  description: string
  category: string
  image: string
  oauth: boolean
  status: string
  tools: number
}

const CATALOGUE_TTL = 24 * 60 * 60 * 1000
let catalogue: { at: number; rows: OnePlatform[] } | null = null

/**
 * The full platform list (≈1000 rows, 150 per page upstream), cached for a
 * day: it changes rarely and the picker filters it client-side.
 */
export async function oneCatalogue(): Promise<OnePlatform[]> {
  if (catalogue && Date.now() - catalogue.at < CATALOGUE_TTL) return catalogue.rows
  const rows: OnePlatform[] = []
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${API_BASE}/available-connectors?limit=150&page=${page}`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new OneError(`One API ${res.status}`, 502)
    const body = (await res.json()) as Page<OnePlatform & { active?: boolean }>
    for (const r of body.rows) {
      if (r.active === false || r.status === 'not_available') continue
      rows.push({
        platform: r.platform,
        name: r.name,
        description: r.description ?? '',
        category: r.category ?? '',
        image: r.image ?? '',
        oauth: !!r.oauth,
        status: r.status,
        tools: r.tools ?? 0,
      })
    }
    if (page >= body.pages || body.rows.length === 0) break
  }
  catalogue = { at: Date.now(), rows }
  return rows
}
