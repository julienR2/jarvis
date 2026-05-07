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

export interface ConnectorDef {
  id: string
  name: string
  description: string
  icon: string       // Lucide icon name
  fields: ConnectorField[]
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
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Push code and manage repositories',
    icon: 'Github',
    fields: [
      { key: 'GITHUB_TOKEN', label: 'Personal access token', type: 'password', placeholder: 'ghp_...' },
    ],
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Track issues and projects',
    icon: 'SquareKanban',
    fields: [
      { key: 'LINEAR_API_KEY', label: 'API key', type: 'password', placeholder: 'lin_api_...' },
    ],
  },
  {
    id: 'imagerouter',
    name: 'ImageRouter',
    description: 'Generate AI images',
    icon: 'Image',
    fields: [
      { key: 'IMAGEROUTER_API_KEY', label: 'API key', type: 'password', placeholder: 'ir-...' },
    ],
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
