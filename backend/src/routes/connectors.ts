import type { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import { extractRequestToken } from '../request-auth.js'
import { conversationByAppToken } from '../app-tokens.js'
import type { ConnectorInput } from '../connectors.js'
import {
  getAllConnectors,
  getConnector,
  createConnector,
  updateConnector,
  deleteConnector,
  getConnectorValues,
} from '../connectors.js'

export async function connectorRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  // GET / — list all connectors (without field values)
  app.get('/', auth, async () => {
    return getAllConnectors().map((c) => ({
      ...c,
      fields: c.fields.map(({ key, label, type }) => ({ key, label, type })),
    }))
  })

  // GET /:id — single connector with current field values (for editing)
  app.get<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const conn = getConnector(req.params.id)
    if (!conn) return reply.code(404).send({ error: 'Unknown connector' })
    return conn
  })

  // POST / — create a connector
  app.post('/', auth, async (req, reply) => {
    try {
      return reply.code(201).send(createConnector((req.body ?? {}) as ConnectorInput))
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'Invalid connector' })
    }
  })

  // PATCH /:id — update a connector (name, icon, fields, proxy)
  app.patch<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const updated = updateConnector(req.params.id, (req.body ?? {}) as ConnectorInput)
    if (!updated) return reply.code(404).send({ error: 'Unknown connector' })
    return updated
  })

  // DELETE /:id — remove a connector entirely
  app.delete<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    if (!deleteConnector(req.params.id)) return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })

  // ── Proxy ──────────────────────────────────────────────────────────────────
  // Parse form-encoded bodies for the write proxy (act=rm etc.)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body))
  // Accept any other content type as raw buffer (file uploads via proxy)
  app.addContentTypeParser(/^(?!application\/json)/, { parseAs: 'buffer', bodyLimit: 100 * 1024 * 1024 }, (_req, body, done) => done(null, body))

  async function handleProxy(req: any, reply: any, method: string) {
    const id = (req.params as any).id as string
    const conn = getConnector(id)
    if (!conn?.proxy) return reply.code(404).send({ error: 'Connector has no proxy' })

    const values = getConnectorValues(id) ?? {}
    const baseUrl = values[conn.proxy.baseUrlField]
    if (!baseUrl) return reply.code(500).send({ error: `${conn.proxy.baseUrlField} not set` })

    const path = ((req.params as any)['*'] as string) ?? ''
    const qIndex = (req.url as string).indexOf('?')
    const qs = qIndex >= 0 ? (req.url as string).slice(qIndex) : ''
    const target = `${baseUrl.replace(/\/$/, '')}/${path}${qs}`

    const headers: Record<string, string> = {}
    if (conn.proxy.authHeader) {
      const v = values[conn.proxy.authHeader.valueField]
      if (v) headers[conn.proxy.authHeader.name] = v
    }
    if (conn.proxy.cookieField) {
      const v = values[conn.proxy.cookieField.valueField]
      if (v) headers['Cookie'] = `${conn.proxy.cookieField.name}=${v}`
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

  /**
   * Authorise a proxy request.
   *
   * Two credentials are accepted, and the difference is the point:
   *
   *  - a session JWT — the owner, from chat or the settings UI. Arrives in the
   *    header, the session cookie, or `?token=`, because `<img>`/`<a>` can't
   *    set a header and this route exists to serve them.
   *  - an app's own token — a generated app calling the one API it needs. It
   *    can proxy through connectors and do nothing else: no conversations, no
   *    git, no plugins, and no reading the connector's stored credentials.
   *
   * The second is why apps no longer borrow the account token out of shared
   * localStorage. An app is the least trusted code here — written by the agent
   * from web content, loading CDN scripts — so it gets a credential that is
   * scoped to this and rotatable on its own.
   */
  async function authorizeProxy(req: any, reply: any): Promise<boolean> {
    const token = extractRequestToken(req)
    if (!token) {
      reply.code(404).send({ error: 'Not found' })
      return false
    }
    if (conversationByAppToken(token)) return true
    try {
      await app.jwt.verify(token)
      return true
    } catch {
      reply.code(404).send({ error: 'Not found' })
      return false
    }
  }

  // GET /:id/proxy/* — stream content from the connector's internal HTTP
  // endpoint. This used to be fully open, which — since the proxy attaches the
  // connector's stored credentials and the backend is internet-reachable —
  // handed anyone who guessed a connector id (they are slugified names)
  // authenticated GET access to that internal service.
  app.get<{ Params: { id: string, '*': string } }>('/:id/proxy/*', async (req, reply) => {
    if (!(await authorizeProxy(req, reply))) return
    return handleProxy(req, reply, 'GET')
  })

  // PUT/POST/DELETE /:id/proxy/* — write through to the upstream service.
  // Apps genuinely write (notes, uploads, bookmarks), so they are allowed here
  // too — still only through a connector, never to the rest of the API.
  app.put<{ Params: { id: string, '*': string } }>('/:id/proxy/*', async (req, reply) => {
    if (!(await authorizeProxy(req, reply))) return
    return handleProxy(req, reply, 'PUT')
  })
  app.post<{ Params: { id: string, '*': string } }>('/:id/proxy/*', async (req, reply) => {
    if (!(await authorizeProxy(req, reply))) return
    return handleProxy(req, reply, 'POST')
  })
  app.delete<{ Params: { id: string, '*': string } }>('/:id/proxy/*', async (req, reply) => {
    if (!(await authorizeProxy(req, reply))) return
    return handleProxy(req, reply, 'DELETE')
  })
}
