import type { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import type { ConnectorField } from '../connectors.js'
import {
  CONNECTOR_CATALOG,
  getCatalogDef,
  getFullCatalog,
  getAllConnectors,
  getConnector,
  getCustomConnector,
  upsertConnector,
  deleteConnector,
  createCustomConnector,
  updateCustomConnector,
  deleteCustomConnector,
} from '../connectors.js'

export async function connectorRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  // GET / — list all connectors (built-in + custom, merged with DB status)
  app.get('/', auth, async () => {
    const saved = new Map(getAllConnectors().map((r) => [r.id, r]))

    return getFullCatalog().map((def) => {
      const row = saved.get(def.id)
      const isCustom = !CONNECTOR_CATALOG.some((c) => c.id === def.id)
      return {
        ...def,
        custom: isCustom,
        connected: !!row,
        connected_at: row?.connected_at ?? null,
        updated_at: row?.updated_at ?? null,
      }
    })
  })

  // GET /:id — single connector with current values (for editing)
  app.get<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const def = getCatalogDef(req.params.id)
    if (!def) return reply.code(404).send({ error: 'Unknown connector' })

    const row = getConnector(req.params.id)
    let secrets: Record<string, string> = {}
    if (row) {
      try { secrets = JSON.parse(row.secrets_json) } catch { /* */ }
    }

    return {
      ...def,
      connected: !!row,
      secrets,
      connected_at: row?.connected_at ?? null,
      updated_at: row?.updated_at ?? null,
    }
  })

  // POST /:id — save connector secrets
  app.post<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const def = getCatalogDef(req.params.id)
    if (!def) return reply.code(404).send({ error: 'Unknown connector' })

    const body = req.body as { secrets: Record<string, string> }
    if (!body.secrets || typeof body.secrets !== 'object') {
      return reply.code(400).send({ error: 'secrets object is required' })
    }

    // Validate all required fields are present and non-empty
    for (const field of def.fields) {
      const val = body.secrets[field.key]
      if (!val || !val.trim()) {
        return reply.code(400).send({ error: `${field.label} is required` })
      }
    }

    // Only keep known fields
    const clean: Record<string, string> = {}
    for (const field of def.fields) {
      clean[field.key] = body.secrets[field.key].trim()
    }

    const row = upsertConnector(req.params.id, clean)
    return {
      ...def,
      connected: true,
      connected_at: row.connected_at,
      updated_at: row.updated_at,
    }
  })

  // POST /:id/test — run the connector's test function against stored or provided secrets
  app.post<{ Params: { id: string } }>('/:id/test', auth, async (req, reply) => {
    const def = getCatalogDef(req.params.id)
    if (!def) return reply.code(404).send({ error: 'Unknown connector' })
    if (!def.test) return { ok: false, message: 'No test available for this connector' }

    // Prefer secrets in the request body (lets the user test unsaved changes).
    // Fall back to what's already saved.
    const body = (req.body ?? {}) as { secrets?: Record<string, string> }
    let secrets = body.secrets
    if (!secrets) {
      const row = getConnector(req.params.id)
      if (!row) return reply.code(400).send({ error: 'Not configured — save secrets first' })
      try { secrets = JSON.parse(row.secrets_json) } catch { secrets = {} }
    }

    try {
      return await def.test(secrets ?? {})
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Test failed' }
    }
  })

  // DELETE /:id — disconnect (remove secrets)
  app.delete<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    if (!deleteConnector(req.params.id)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    return { ok: true }
  })

  // ── Custom connector definition CRUD ──────────────────────────────────────

  app.post('/custom', auth, async (req, reply) => {
    const body = req.body as { name?: string; description?: string; icon?: string; fields?: ConnectorField[] }
    if (!body.name?.trim()) return reply.code(400).send({ error: 'Name is required' })
    if (!body.fields?.length) return reply.code(400).send({ error: 'At least one field is required' })

    const id = body.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!id) return reply.code(400).send({ error: 'Name must contain alphanumeric characters' })

    const existing = getCatalogDef(id)
    if (existing) return reply.code(409).send({ error: 'A connector with this ID already exists' })

    const row = createCustomConnector({
      id,
      name: body.name.trim(),
      description: (body.description ?? '').trim(),
      icon: body.icon ?? 'Plug',
      fields: body.fields.map((f) => ({
        key: f.key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
        label: f.label.trim(),
        type: f.type || 'password',
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      })),
    })
    return reply.code(201).send(row)
  })

  app.patch<{ Params: { id: string } }>('/custom/:id', auth, async (req, reply) => {
    const custom = getCustomConnector(req.params.id)
    if (!custom) return reply.code(404).send({ error: 'Custom connector not found' })

    const body = req.body as { name?: string; description?: string; icon?: string; fields?: ConnectorField[] }
    const updated = updateCustomConnector(req.params.id, {
      name: body.name?.trim(),
      description: body.description?.trim(),
      icon: body.icon,
      fields: body.fields?.map((f) => ({
        key: f.key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
        label: f.label.trim(),
        type: f.type || 'password',
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      })),
    })
    return updated
  })

  app.delete<{ Params: { id: string } }>('/custom/:id', auth, async (req, reply) => {
    if (!deleteCustomConnector(req.params.id)) {
      return reply.code(404).send({ error: 'Custom connector not found' })
    }
    return { ok: true }
  })

  // Parse form-encoded bodies for the write proxy (act=rm etc.)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body))

  async function handleProxy(req: any, reply: any, method: string) {
    const id = (req.params as any).id as string
    const def = getCatalogDef(id)
    if (!def?.proxy) return reply.code(404).send({ error: 'Connector has no proxy' })

    const row = getConnector(id)
    if (!row) return reply.code(404).send({ error: 'Connector not configured' })

    let secrets: Record<string, string>
    try { secrets = JSON.parse(row.secrets_json) } catch { return reply.code(500).send({ error: 'Invalid secrets' }) }

    const baseUrl = secrets[def.proxy.baseUrlField]
    if (!baseUrl) return reply.code(500).send({ error: `${def.proxy.baseUrlField} not set` })

    const path = ((req.params as any)['*'] as string) ?? ''
    const qIndex = (req.url as string).indexOf('?')
    const qs = qIndex >= 0 ? (req.url as string).slice(qIndex) : ''
    const target = `${baseUrl.replace(/\/$/, '')}/${path}${qs}`

    const headers: Record<string, string> = {}
    if (def.proxy.authHeader) {
      const v = secrets[def.proxy.authHeader.valueField]
      if (v) headers[def.proxy.authHeader.name] = v
    }
    if (def.proxy.cookieField) {
      const v = secrets[def.proxy.cookieField.valueField]
      if (v) headers['Cookie'] = `${def.proxy.cookieField.name}=${v}`
    }

    const fetchInit: RequestInit = { method, headers }
    if (method !== 'GET' && method !== 'HEAD') {
      const ct = req.headers['content-type'] as string | undefined
      if (ct) headers['Content-Type'] = ct
      const body = req.body
      if (body !== undefined && body !== null) {
        fetchInit.body = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body : JSON.stringify(body)
      }
    }

    let upstream: Response
    try {
      upstream = await fetch(target, fetchInit)
    } catch (err: any) {
      return reply.code(502).send({ error: 'Upstream unreachable', message: err?.message })
    }

    reply.code(upstream.status)
    for (const h of ['content-type', 'content-length', 'content-disposition', 'last-modified', 'etag', 'cache-control']) {
      const v = upstream.headers.get(h)
      if (v) reply.header(h, v)
    }
    if (!upstream.body) return reply.send()
    return reply.send(Readable.fromWeb(upstream.body as any))
  }

  // GET /:id/proxy/* — stream content from the connector's internal HTTP endpoint.
  // Unauthenticated by design: <img>/<a> tags can't send headers. Same threat model
  // as /api/uploads/files/ — URLs are only surfaced inside JWT-gated chat + apps.
  app.get<{ Params: { id: string, '*': string } }>('/:id/proxy/*', async (req, reply) => {
    return handleProxy(req, reply, 'GET')
  })

  // PUT/POST/DELETE /:id/proxy/* — write through to the upstream service.
  // JWT-protected because these are mutating operations.
  app.put<{ Params: { id: string, '*': string } }>('/:id/proxy/*', auth, async (req, reply) => {
    return handleProxy(req, reply, 'PUT')
  })
  app.post<{ Params: { id: string, '*': string } }>('/:id/proxy/*', auth, async (req, reply) => {
    return handleProxy(req, reply, 'POST')
  })
  app.delete<{ Params: { id: string, '*': string } }>('/:id/proxy/*', auth, async (req, reply) => {
    return handleProxy(req, reply, 'DELETE')
  })
}
