import { getDb } from './db.js'
import type { ConnectorRow } from './types.js'

// ── Connector model ──────────────────────────────────────────────────────────
// A connector is a single DB row: a human name + icon + a list of {label, value}
// fields (each with a stable machine `key`), plus an optional proxy config. There
// is no hardcoded catalog — every connector, built-in or not, is just a row.

export interface ConnectorField {
  key: string                       // stable machine key (auto-derived from label)
  label: string                     // human label shown in the UI
  value: string                     // the secret / value
  type?: 'text' | 'password' | 'email'
}

// Lets a connector expose its internal HTTP service through jarvis-backend at
// `/api/connectors/:id/proxy/*`, using a stored base URL and auth. Used for
// inline content (e.g. drive images) that <img> tags can't authenticate for.
export interface ConnectorProxy {
  baseUrlField: string                               // field key holding the internal base URL
  authHeader?: { name: string; valueField: string }  // header name + field key holding its value
  cookieField?: { name: string; valueField: string } // cookie name + field key holding its value
}

export interface Connector {
  id: string
  name: string
  description: string
  icon: string
  fields: ConnectorField[]
  proxy?: ConnectorProxy
  created_at: number
  updated_at: number
}

export interface ConnectorInput {
  name?: string
  description?: string
  icon?: string
  fields?: Array<{ key?: string; label: string; value: string; type?: ConnectorField['type'] }>
  proxy?: ConnectorProxy | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function slugifyId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// Derive a stable UPPER_SNAKE key from a label, deduping within a connector.
function deriveKey(label: string, taken: Set<string>): string {
  let base = label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  if (!base) base = 'FIELD'
  let key = base
  let n = 2
  while (taken.has(key)) key = `${base}_${n++}`
  taken.add(key)
  return key
}

function normalizeFields(input: ConnectorInput['fields']): ConnectorField[] {
  const taken = new Set<string>()
  return (input ?? [])
    .filter((f) => f.label?.trim())
    .map((f) => {
      const key = f.key?.trim() ? f.key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_') : deriveKey(f.label, taken)
      taken.add(key)
      return { key, label: f.label.trim(), value: (f.value ?? '').trim(), type: f.type || 'password' }
    })
}

function rowToConnector(row: ConnectorRow): Connector {
  let fields: ConnectorField[] = []
  let proxy: ConnectorProxy | undefined
  try { fields = JSON.parse(row.fields_json) } catch { /* */ }
  try { proxy = row.proxy_json ? JSON.parse(row.proxy_json) as ConnectorProxy : undefined } catch { /* */ }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    fields,
    proxy,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function getAllConnectors(): Connector[] {
  return (getDb().prepare('SELECT * FROM connectors ORDER BY created_at ASC').all() as ConnectorRow[])
    .map(rowToConnector)
}

export function getConnector(id: string): Connector | undefined {
  const row = getDb().prepare('SELECT * FROM connectors WHERE id = ?').get(id) as ConnectorRow | undefined
  return row ? rowToConnector(row) : undefined
}

export function createConnector(input: ConnectorInput): Connector {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('Name is required')
  const id = slugifyId(name)
  if (!id) throw new Error('Name must contain alphanumeric characters')
  if (getConnector(id)) throw new Error('A connector with this name already exists')

  const fields = normalizeFields(input.fields)
  getDb().prepare(`
    INSERT INTO connectors (id, name, description, icon, fields_json, proxy_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    (input.description ?? '').trim(),
    input.icon || 'Plug',
    JSON.stringify(fields),
    input.proxy ? JSON.stringify(input.proxy) : null,
  )
  return getConnector(id)!
}

export function updateConnector(id: string, input: ConnectorInput): Connector | null {
  const existing = getConnector(id)
  if (!existing) return null

  const fields = input.fields ? normalizeFields(input.fields) : existing.fields
  const proxy = input.proxy === undefined ? existing.proxy : (input.proxy ?? undefined)
  getDb().prepare(`
    UPDATE connectors
    SET name = ?, description = ?, icon = ?, fields_json = ?, proxy_json = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(
    input.name?.trim() || existing.name,
    input.description !== undefined ? input.description.trim() : existing.description,
    input.icon ?? existing.icon,
    JSON.stringify(fields),
    proxy ? JSON.stringify(proxy) : null,
    id,
  )
  return getConnector(id)!
}

export function deleteConnector(id: string): boolean {
  return getDb().prepare('DELETE FROM connectors WHERE id = ?').run(id).changes > 0
}

// Flat { key: value } map for a connector — used by the proxy handler and the
// internal secrets endpoint.
export function getConnectorValues(id: string): Record<string, string> | null {
  const conn = getConnector(id)
  if (!conn) return null
  const out: Record<string, string> = {}
  for (const f of conn.fields) out[f.key] = f.value
  return out
}
