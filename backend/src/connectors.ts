import { getDb } from './db.js'
import type { ConnectorRow, CustomConnectorRow } from './types.js'

// ── Connector catalog ───────────────────────────────────────────────────────
// Each entry defines a connector with the env vars it injects into the Claude
// process. The catalog is hardcoded — add new connectors here.

export interface ConnectorField {
  key: string       // env var name
  label: string
  type: 'text' | 'password' | 'email'
  placeholder?: string
}

export interface ConnectorTestResult {
  ok: boolean
  message: string
}

// Lets a connector expose its internal HTTP service through jarvis-backend
// at `/api/connectors/:id/proxy/*`, using the stored base URL and auth header.
// Used for inline content (e.g. drive images) that <img> tags can't auth for.
export interface ConnectorProxy {
  baseUrlField: string                                  // secret key holding the internal base URL
  authHeader?: { name: string; valueField: string }     // header name + secret key holding its value
  cookieField?: { name: string; valueField: string }    // cookie name + secret key holding its value
}

export interface ConnectorDef {
  id: string
  name: string
  description: string
  icon: string       // Lucide icon name
  fields: ConnectorField[]
  test?: (secrets: Record<string, string>) => Promise<ConnectorTestResult>
  proxy?: ConnectorProxy
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 5000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export const CONNECTOR_CATALOG: ConnectorDef[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Send and read emails via Gmail',
    icon: 'Mail',
    fields: [
      { key: 'GMAIL_ADDRESS', label: 'Email address', type: 'email', placeholder: 'you@gmail.com' },
      { key: 'GMAIL_APP_PASSWORD', label: 'App password', type: 'password', placeholder: 'xxxx xxxx xxxx xxxx' },
    ],
    test: async ({ GMAIL_ADDRESS, GMAIL_APP_PASSWORD }) => {
      if (!/^[^@\s]+@(gmail\.com|googlemail\.com)$/i.test(GMAIL_ADDRESS ?? '')) {
        return { ok: false, message: 'Email must be a Gmail address' }
      }
      if ((GMAIL_APP_PASSWORD ?? '').replace(/\s/g, '').length !== 16) {
        return { ok: false, message: 'App passwords are 16 characters (spaces are ignored)' }
      }
      return { ok: true, message: 'Format looks correct — SMTP auth is verified on first send.' }
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Push code and manage repositories',
    icon: 'Github',
    fields: [
      { key: 'GITHUB_TOKEN', label: 'Personal access token', type: 'password', placeholder: 'ghp_...' },
    ],
    test: async ({ GITHUB_TOKEN }) => {
      const r = await fetchWithTimeout('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'jarvis' },
      })
      if (r.ok) {
        const { login } = await r.json() as { login: string }
        return { ok: true, message: `Connected as @${login}` }
      }
      if (r.status === 401) return { ok: false, message: 'Invalid token' }
      return { ok: false, message: `GitHub API returned ${r.status}` }
    },
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Track issues and projects',
    icon: 'SquareKanban',
    fields: [
      { key: 'LINEAR_API_KEY', label: 'API key', type: 'password', placeholder: 'lin_api_...' },
    ],
    test: async ({ LINEAR_API_KEY }) => {
      const r = await fetchWithTimeout('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: LINEAR_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: '{ viewer { name } }' }),
      })
      const data = await r.json().catch(() => null) as { data?: { viewer?: { name: string } }, errors?: Array<{ message: string }> } | null
      if (data?.data?.viewer?.name) {
        return { ok: true, message: `Connected as ${data.data.viewer.name}` }
      }
      return { ok: false, message: data?.errors?.[0]?.message ?? 'Invalid API key' }
    },
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Send and read messages as yourself',
    icon: 'MessageSquare',
    fields: [
      { key: 'SLACK_USER_TOKEN', label: 'User OAuth token', type: 'password', placeholder: 'xoxp-...' },
    ],
    test: async ({ SLACK_USER_TOKEN }) => {
      if (!SLACK_USER_TOKEN?.startsWith('xoxp-')) {
        return { ok: false, message: 'User tokens start with xoxp-' }
      }
      const r = await fetchWithTimeout('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${SLACK_USER_TOKEN}` },
      })
      const data = await r.json().catch(() => null) as { ok?: boolean; user?: string; error?: string } | null
      if (data?.ok) return { ok: true, message: `Connected as ${data.user}` }
      return { ok: false, message: data?.error ?? 'Invalid token' }
    },
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    description: 'Speech-to-text + text-to-speech. Key needs scopes: user_read, speech_to_text, text_to_speech',
    icon: 'AudioLines',
    fields: [
      { key: 'ELEVENLABS_API_KEY', label: 'API key', type: 'password', placeholder: 'sk_...' },
    ],
    test: async ({ ELEVENLABS_API_KEY }) => {
      const r = await fetchWithTimeout('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      })
      if (r.ok) {
        const data = await r.json().catch(() => null) as { first_name?: string } | null
        return { ok: true, message: `Connected${data?.first_name ? ` as ${data.first_name}` : ''}` }
      }
      if (r.status === 401) {
        const body = await r.json().catch(() => null) as { detail?: { status?: string } } | null
        if (body?.detail?.status === 'missing_permissions') {
          return { ok: false, message: 'Key is missing user_read scope — regenerate it with user_read, speech_to_text, text_to_speech' }
        }
        return { ok: false, message: 'Invalid API key' }
      }
      return { ok: false, message: `ElevenLabs returned ${r.status}` }
    },
  },
  {
    id: 'pocketbase',
    name: 'PocketBase',
    description: 'Self-hosted backend — collections, records, financial data',
    icon: 'Database',
    fields: [
      { key: 'POCKETBASE_URL', label: 'Base URL', type: 'text', placeholder: 'http://pocketbase:8080' },
      { key: 'POCKETBASE_EMAIL', label: 'Admin email', type: 'email', placeholder: 'admin@example.com' },
      { key: 'POCKETBASE_PASSWORD', label: 'Admin password', type: 'password' },
    ],
    test: async ({ POCKETBASE_URL, POCKETBASE_EMAIL, POCKETBASE_PASSWORD }) => {
      if (!POCKETBASE_URL?.startsWith('http')) {
        return { ok: false, message: 'Base URL must start with http(s)://' }
      }
      const url = POCKETBASE_URL.replace(/\/$/, '') + '/api/collections/_superusers/auth-with-password'
      const r = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: POCKETBASE_EMAIL, password: POCKETBASE_PASSWORD }),
      }).catch(() => null)
      if (!r) return { ok: false, message: 'Could not reach PocketBase (check the base URL)' }
      if (r.ok) {
        const data = await r.json().catch(() => null) as { record?: { email: string } } | null
        return { ok: true, message: `Connected as ${data?.record?.email ?? POCKETBASE_EMAIL}` }
      }
      if (r.status === 400) return { ok: false, message: 'Invalid email or password' }
      if (r.status === 404) return { ok: false, message: 'Endpoint not found — check the base URL points to a PocketBase 0.23+ server' }
      return { ok: false, message: `PocketBase returned ${r.status}` }
    },
  },
  {
    id: 'copyparty',
    name: 'Copyparty',
    description: 'Personal file drive — browse, upload, and manage files',
    icon: 'HardDrive',
    fields: [
      { key: 'COPYPARTY_BASE_URL', label: 'Base URL', type: 'text', placeholder: 'http://copyparty:3923' },
      { key: 'COPYPARTY_PASSWORD', label: 'Password', type: 'password' },
    ],
    proxy: {
      baseUrlField: 'COPYPARTY_BASE_URL',
      cookieField: { name: 'cppwd', valueField: 'COPYPARTY_PASSWORD' },
    },
    test: async ({ COPYPARTY_BASE_URL, COPYPARTY_PASSWORD }) => {
      if (!COPYPARTY_BASE_URL?.startsWith('http')) {
        return { ok: false, message: 'Base URL must start with http(s)://' }
      }
      const r = await fetchWithTimeout(`${COPYPARTY_BASE_URL.replace(/\/$/, '')}/?ls`, {
        headers: { Cookie: `cppwd=${COPYPARTY_PASSWORD}` },
      }).catch(() => null)
      if (!r) return { ok: false, message: 'Could not reach Copyparty' }
      if (r.ok) return { ok: true, message: 'Connected' }
      return { ok: false, message: `Copyparty returned ${r.status}` }
    },
  },
  {
    id: 'imagerouter',
    name: 'ImageRouter',
    description: 'Generate AI images (Flux, SDXL, DALL·E, Ideogram…)',
    icon: 'Image',
    fields: [
      { key: 'IMAGEROUTER_API_KEY', label: 'API key', type: 'password', placeholder: 'ir_...' },
    ],
    test: async ({ IMAGEROUTER_API_KEY }) => {
      const r = await fetchWithTimeout('https://api.imagerouter.io/v1/models', {
        headers: { Authorization: `Bearer ${IMAGEROUTER_API_KEY}` },
      })
      if (r.ok) {
        const data = await r.json().catch(() => null) as { data?: unknown[] } | unknown[] | null
        const count = Array.isArray(data) ? data.length : Array.isArray((data as any)?.data) ? (data as any).data.length : 0
        return { ok: true, message: count ? `Connected — ${count} models available` : 'Connected' }
      }
      if (r.status === 401) return { ok: false, message: 'Invalid API key' }
      return { ok: false, message: `ImageRouter returned ${r.status}` }
    },
  },
]

const catalogMap = new Map(CONNECTOR_CATALOG.map((c) => [c.id, c]))

function customRowToDef(row: CustomConnectorRow): ConnectorDef {
  let fields: ConnectorField[] = []
  try { fields = JSON.parse(row.fields_json) } catch { /* */ }
  return { id: row.id, name: row.name, description: row.description, icon: row.icon, fields }
}

export function getCatalogDef(id: string): ConnectorDef | undefined {
  const builtin = catalogMap.get(id)
  if (builtin) return builtin
  const custom = getDb().prepare('SELECT * FROM custom_connectors WHERE id = ?').get(id) as CustomConnectorRow | undefined
  return custom ? customRowToDef(custom) : undefined
}

export function getFullCatalog(): ConnectorDef[] {
  const customs = (getDb().prepare('SELECT * FROM custom_connectors ORDER BY created_at ASC').all() as CustomConnectorRow[])
    .map(customRowToDef)
  return [...CONNECTOR_CATALOG, ...customs]
}

// ── Custom connector CRUD ─────────────────────────────────────────────────

export function getAllCustomConnectors(): CustomConnectorRow[] {
  return getDb().prepare('SELECT * FROM custom_connectors ORDER BY created_at ASC').all() as CustomConnectorRow[]
}

export function getCustomConnector(id: string): CustomConnectorRow | undefined {
  return getDb().prepare('SELECT * FROM custom_connectors WHERE id = ?').get(id) as CustomConnectorRow | undefined
}

export function createCustomConnector(def: { id: string; name: string; description: string; icon: string; fields: ConnectorField[] }): CustomConnectorRow {
  getDb()
    .prepare('INSERT INTO custom_connectors (id, name, description, icon, fields_json) VALUES (?, ?, ?, ?, ?)')
    .run(def.id, def.name, def.description, def.icon, JSON.stringify(def.fields))
  return getCustomConnector(def.id)!
}

export function updateCustomConnector(id: string, def: { name?: string; description?: string; icon?: string; fields?: ConnectorField[] }): CustomConnectorRow | null {
  const existing = getCustomConnector(id)
  if (!existing) return null
  getDb()
    .prepare('UPDATE custom_connectors SET name = ?, description = ?, icon = ?, fields_json = ?, updated_at = unixepoch() WHERE id = ?')
    .run(
      def.name ?? existing.name,
      def.description ?? existing.description,
      def.icon ?? existing.icon,
      def.fields ? JSON.stringify(def.fields) : existing.fields_json,
      id,
    )
  return getCustomConnector(id)!
}

export function deleteCustomConnector(id: string): boolean {
  deleteConnector(id)
  return getDb().prepare('DELETE FROM custom_connectors WHERE id = ?').run(id).changes > 0
}

// ── DB helpers ──────────────────────────────────────────────────────────────

export function getAllConnectors(): ConnectorRow[] {
  return getDb().prepare('SELECT * FROM connectors ORDER BY connected_at ASC').all() as ConnectorRow[]
}

export function getConnector(id: string): ConnectorRow | undefined {
  return getDb().prepare('SELECT * FROM connectors WHERE id = ?').get(id) as ConnectorRow | undefined
}

export function upsertConnector(id: string, secrets: Record<string, string>): ConnectorRow {
  const existing = getConnector(id)
  if (existing) {
    getDb()
      .prepare('UPDATE connectors SET secrets_json = ?, updated_at = unixepoch() WHERE id = ?')
      .run(JSON.stringify(secrets), id)
  } else {
    getDb()
      .prepare('INSERT INTO connectors (id, secrets_json) VALUES (?, ?)')
      .run(id, JSON.stringify(secrets))
  }
  return getConnector(id)!
}

export function deleteConnector(id: string): boolean {
  const result = getDb().prepare('DELETE FROM connectors WHERE id = ?').run(id)
  return result.changes > 0
}

export function getConnectorSecrets(id: string): Record<string, string> | null {
  const row = getConnector(id)
  if (!row) return null
  try {
    return JSON.parse(row.secrets_json) as Record<string, string>
  } catch { return null }
}

// ── Env var export ──────────────────────────────────────────────────────────
// Returns a flat object of all env vars from all connected connectors.
// Used to inject into the Claude process env.

export function getConnectorEnvVars(): Record<string, string> {
  const rows = getAllConnectors()
  const env: Record<string, string> = {}
  for (const row of rows) {
    try {
      const secrets = JSON.parse(row.secrets_json) as Record<string, string>
      Object.assign(env, secrets)
    } catch { /* skip malformed */ }
  }
  return env
}
