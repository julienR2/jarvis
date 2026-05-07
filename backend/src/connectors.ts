import { getDb } from './db.js'
import type { ConnectorRow } from './types.js'

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
    id: 'imagerouter',
    name: 'ImageRouter',
    description: 'Generate AI images',
    icon: 'Image',
    fields: [
      { key: 'IMAGEROUTER_API_KEY', label: 'API key', type: 'password', placeholder: 'ir-...' },
    ],
    test: async ({ IMAGEROUTER_API_KEY }) => {
      const r = await fetchWithTimeout('https://api.imagerouter.io/v1/openai/models', {
        headers: { Authorization: `Bearer ${IMAGEROUTER_API_KEY}` },
      })
      if (r.ok) return { ok: true, message: 'API key valid' }
      if (r.status === 401) return { ok: false, message: 'Invalid API key' }
      return { ok: false, message: `ImageRouter returned ${r.status}` }
    },
  },
  {
    id: 'pocketbase',
    name: 'PocketBase',
    description: 'Access financial data and records',
    icon: 'Database',
    fields: [
      { key: 'POCKETBASE_INTERNAL_URL', label: 'Internal URL', type: 'text', placeholder: 'http://pocketbase:8090' },
      { key: 'POCKETBASE_PUBLIC_URL', label: 'Public URL', type: 'text', placeholder: 'https://pb.example.com' },
      { key: 'POCKETBASE_EMAIL', label: 'Email', type: 'email' },
      { key: 'POCKETBASE_PASSWORD', label: 'Password', type: 'password' },
    ],
    test: async (s) => {
      const url = s.POCKETBASE_INTERNAL_URL || s.POCKETBASE_PUBLIC_URL
      if (!url) return { ok: false, message: 'No URL provided' }
      const body = JSON.stringify({ identity: s.POCKETBASE_EMAIL, password: s.POCKETBASE_PASSWORD })
      // Try the PocketBase v0.23+ superusers endpoint first, then fall back to legacy admins.
      for (const path of ['/api/collections/_superusers/auth-with-password', '/api/admins/auth-with-password']) {
        try {
          const r = await fetchWithTimeout(`${url.replace(/\/$/, '')}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
          if (r.ok) return { ok: true, message: 'PocketBase admin login successful' }
          if (r.status === 400) return { ok: false, message: 'Invalid credentials' }
        } catch { /* try next path */ }
      }
      return { ok: false, message: 'Could not reach PocketBase' }
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
    id: 'copyparty',
    name: 'Copyparty',
    description: 'Browse and manage files on personal drive',
    icon: 'HardDrive',
    fields: [
      { key: 'COPYPARTY_INTERNAL_URL', label: 'Internal URL', type: 'text', placeholder: 'http://copyparty:3923' },
      { key: 'COPYPARTY_PUBLIC_URL', label: 'Public URL', type: 'text', placeholder: 'https://drive.example.com' },
      { key: 'COPYPARTY_PASSWORD', label: 'Password', type: 'password' },
    ],
    proxy: {
      baseUrlField: 'COPYPARTY_INTERNAL_URL',
      authHeader: { name: 'PW', valueField: 'COPYPARTY_PASSWORD' },
    },
    test: async (s) => {
      const url = s.COPYPARTY_INTERNAL_URL || s.COPYPARTY_PUBLIC_URL
      if (!url) return { ok: false, message: 'No URL provided' }
      try {
        const r = await fetchWithTimeout(`${url.replace(/\/$/, '')}/?ls`, {
          headers: { PW: s.COPYPARTY_PASSWORD ?? '' },
        })
        if (r.ok) return { ok: true, message: 'Copyparty reachable' }
        if (r.status === 401 || r.status === 403) return { ok: false, message: 'Wrong password' }
        return { ok: false, message: `Copyparty returned ${r.status}` }
      } catch {
        return { ok: false, message: 'Could not reach Copyparty' }
      }
    },
  },
]

const catalogMap = new Map(CONNECTOR_CATALOG.map((c) => [c.id, c]))

export function getCatalogDef(id: string): ConnectorDef | undefined {
  return catalogMap.get(id)
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
