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
//
// It is also how the agent uses a connector whose values are hidden from it
// (`hideValues`): it calls the proxy, and the backend adds the credential.
export interface ConnectorProxy {
  baseUrlField: string                               // field key holding the internal base URL
  // header name + field key holding its value, sent as `${prefix}${value}`
  // (prefix e.g. "Bearer ")
  authHeader?: { name: string; valueField: string; prefix?: string }
  cookieField?: { name: string; valueField: string } // cookie name + field key holding its value
}

export interface Connector {
  id: string
  name: string
  description: string
  icon: string
  fields: ConnectorField[]
  proxy?: ConnectorProxy
  // Secret fields are withheld from the agent; it reaches the service through
  // the proxy instead. Non-secret fields (a URL, an address) stay readable.
  hideValues: boolean
  created_at: number
  updated_at: number
}

export interface ConnectorInput {
  name?: string
  description?: string
  icon?: string
  fields?: Array<{ key?: string; label: string; value: string; type?: ConnectorField['type'] }>
  proxy?: ConnectorProxy | null
  hideValues?: boolean
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

// Keep only the known shape, so nothing unexpected is stored and replayed into
// the proxy's outgoing requests.
function normalizeProxy(p: ConnectorProxy): ConnectorProxy {
  const key = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const out: ConnectorProxy = { baseUrlField: key(p.baseUrlField) }
  if (p.authHeader && key(p.authHeader.name) && key(p.authHeader.valueField)) {
    out.authHeader = { name: key(p.authHeader.name), valueField: key(p.authHeader.valueField) }
    if (typeof p.authHeader.prefix === 'string' && p.authHeader.prefix) out.authHeader.prefix = p.authHeader.prefix
  }
  if (p.cookieField && key(p.cookieField.name) && key(p.cookieField.valueField)) {
    out.cookieField = { name: key(p.cookieField.name), valueField: key(p.cookieField.valueField) }
  }
  return out
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
    hideValues: !!row.hide_values,
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
    INSERT INTO connectors (id, name, description, icon, fields_json, proxy_json, hide_values)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    (input.description ?? '').trim(),
    input.icon || 'Plug',
    JSON.stringify(fields),
    input.proxy ? JSON.stringify(normalizeProxy(input.proxy)) : null,
    input.hideValues ? 1 : 0,
  )
  return getConnector(id)!
}

export function updateConnector(id: string, input: ConnectorInput): Connector | null {
  const existing = getConnector(id)
  if (!existing) return null

  const fields = input.fields ? normalizeFields(input.fields) : existing.fields
  const proxy = input.proxy === undefined ? existing.proxy : (input.proxy ? normalizeProxy(input.proxy) : undefined)
  const hideValues = input.hideValues === undefined ? existing.hideValues : !!input.hideValues
  getDb().prepare(`
    UPDATE connectors
    SET name = ?, description = ?, icon = ?, fields_json = ?, proxy_json = ?, hide_values = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(
    input.name?.trim() || existing.name,
    input.description !== undefined ? input.description.trim() : existing.description,
    input.icon ?? existing.icon,
    JSON.stringify(fields),
    proxy ? JSON.stringify(proxy) : null,
    hideValues ? 1 : 0,
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
