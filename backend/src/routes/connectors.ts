import type { FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import { extractRequestToken } from '../request-auth.js'
import { conversationByAppToken } from '../app-tokens.js'
import { hasInternalSecret } from '../security.js'
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

  // Request headers never forwarded upstream: the caller's Jarvis credentials,
  // hop-by-hop headers, and ones fetch computes itself.
  const DROP_HEADERS = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade',
    'accept-encoding', 'authorization', 'cookie', 'x-internal-secret', 'origin', 'referer',
    'x-real-ip', 'proxy-authorization', 'te', 'trailer',
  ])

  async function handleProxy(req: any, reply: any, method: string) {
    const id = (req.params as any).id as string
    const conn = getConnector(id)
    if (!conn?.proxy) return reply.code(404).send({ error: 'Connector has no proxy' })

    const values = getConnectorValues(id) ?? {}
    const baseUrl = values[conn.proxy.baseUrlField]
    if (!baseUrl) return reply.code(500).send({ error: `${conn.proxy.baseUrlField} not set` })

    const path = ((req.params as any)['*'] as string) ?? ''
    // The query string goes upstream, minus `token`: that is how <img>/<a>
    // authenticate to this route, and it is the caller's Jarvis session, not
    // something the upstream service should ever see.
    const url = new URL(req.url as string, 'http://x')
    url.searchParams.delete('token')
    const qs = url.search
    const base = baseUrl.replace(/\/$/, '')
    const target = `${base}/${path}${qs}`

    // The caller's headers go upstream (an API wants its Accept, its version
    // header, its content type) — minus anything that identifies the caller to
    // Jarvis, and the hop-by-hop ones fetch sets itself. The connector's own
    // credential is added after, so a caller cannot override it.
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers as Record<string, string | string[] | undefined>)) {
      if (value === undefined || DROP_HEADERS.has(name) || name.startsWith('sec-') || name.startsWith('x-forwarded-')) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    if (conn.proxy.authHeader) {
      const v = values[conn.proxy.authHeader.valueField]
      if (v) headers[conn.proxy.authHeader.name] = `${conn.proxy.authHeader.prefix ?? ''}${v}`
    }
    if (conn.proxy.cookieField) {
      const v = values[conn.proxy.cookieField.valueField]
      if (v) headers['Cookie'] = `${conn.proxy.cookieField.name}=${v}`
    }

    // Redirects are followed by hand, and only within the connector's own
    // origin: fetch would carry a custom auth header (X-Api-Key…) to wherever
    // the upstream points, and a redirect is all it takes to read it there.
    const fetchInit: RequestInit = { method, headers, redirect: 'manual' }
    if (method !== 'GET' && method !== 'HEAD') {
      const body = req.body
      if (body !== undefined && body !== null) {
        if (typeof body === 'string') {
          fetchInit.body = body
        } else if (Buffer.isBuffer(body)) {
          // `BodyInit` wants an ArrayBuffer-backed view, but a Node Buffer is typed
          // over the wider `ArrayBufferLike`. Re-wrap as a zero-copy view instead of
          // copying the whole payload through `new Uint8Array(body)` — this proxy
          // carries uploads.
          fetchInit.body = new Uint8Array(
            body.buffer as ArrayBuffer,
            body.byteOffset,
            body.byteLength,
          )
        } else {
          fetchInit.body = JSON.stringify(body)
          headers['content-type'] = 'application/json'
        }
      }
    }

    let upstream!: Response
    try {
      let next = target
      const origin = new URL(base).origin
      for (let hop = 0; ; hop++) {
        upstream = await fetch(next, fetchInit)
        const location = upstream.headers.get('location')
        if (upstream.status < 300 || upstream.status >= 400 || !location || hop >= 5) break
        const to = new URL(location, next)
        if (to.origin !== origin) break // handed back as-is, credential not sent
        next = to.toString()
        // 303 (and, by convention, 301/302 after a POST) turn into a GET.
        if (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && method === 'POST')) {
          fetchInit.method = 'GET'
          delete fetchInit.body
        }
      }
    } catch (err: any) {
      return reply.code(502).send({ error: 'Upstream unreachable', message: err?.message })
    }

    reply.code(upstream.status)
    // content-length only when the body is passed through untouched: fetch
    // decompresses gzip/br, and the upstream's length would then cut it short.
    const compressed = !!upstream.headers.get('content-encoding')
    for (const h of ['content-type', 'content-length', 'content-disposition', 'last-modified', 'etag', 'cache-control', 'link', 'location']) {
      if (h === 'content-length' && compressed) continue
      const v = upstream.headers.get(h)
      if (v) reply.header(h, v)
    }
    if (!upstream.body) return reply.send()
    return reply.send(Readable.fromWeb(upstream.body as any))
  }

  /**
   * Authorise a proxy request.
   *
   * Three credentials are accepted, and the difference is the point:
   *
   *  - a session JWT — the owner, from chat or the settings UI. Arrives in the
   *    header, the session cookie, or `?token=`, because `<img>`/`<a>` can't
   *    set a header and this route exists to serve them.
   *  - an app's own token — a generated app calling the one API it needs. It
   *    can proxy through connectors and do nothing else: no conversations, no
   *    git, no plugins, and no reading the connector's stored credentials.
   *  - the internal secret — the agent. This is how it uses a connector whose
   *    values are hidden from it: the request goes through here, and the
   *    credential is added on the way out.
   *
   * The app token is why apps no longer borrow the account token out of shared
   * localStorage. An app is the least trusted code here — written by the agent
   * from web content, loading CDN scripts — so it gets a credential that is
   * scoped to this and rotatable on its own.
   */
  async function authorizeProxy(req: any, reply: any): Promise<boolean> {
    if (hasInternalSecret(req)) return true
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
  app.patch<{ Params: { id: string, '*': string } }>('/:id/proxy/*', async (req, reply) => {
    if (!(await authorizeProxy(req, reply))) return
    return handleProxy(req, reply, 'PATCH')
  })
}
