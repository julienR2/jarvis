import type { FastifyInstance } from 'fastify'
import {
  CONNECTOR_CATALOG,
  getCatalogDef,
  getAllConnectors,
  getConnector,
  upsertConnector,
  deleteConnector,
} from '../connectors.js'

export async function connectorRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  // GET / — list all connectors (catalog merged with DB status)
  app.get('/', auth, async () => {
    const saved = new Map(getAllConnectors().map((r) => [r.id, r]))

    return CONNECTOR_CATALOG.map((def) => {
      const row = saved.get(def.id)
      return {
        ...def,
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
}
