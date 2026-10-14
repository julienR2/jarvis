import type { FastifyInstance, FastifyReply } from 'fastify'
import { recycleSessions } from '../engine.js'
import {
  OneError,
  deleteOneConnection,
  listOneConnections,
  oneCatalogue,
  oneEnvironment,
  oneSettings,
  saveOneSettings,
} from '../one.js'

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof OneError) return reply.code(err.status).send({ error: err.message })
  console.error('[one]', err)
  return reply.code(502).send({ error: 'Could not reach One' })
}

/** The key never goes back to the browser — only enough to recognise it. */
function keyHint(key: string): string {
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

export async function oneRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate)

  // GET /status — is One plugged in, and with which key.
  app.get('/status', async () => {
    const { key, enabled } = oneSettings()
    return {
      configured: !!key,
      enabled,
      keyHint: key ? keyHint(key) : null,
      environment: key ? oneEnvironment(key) : null,
    }
  })

  // PUT /key — verify a key against One, then store it. Verification is not
  // optional: a key One refuses would silently give the agent a broken server.
  app.put<{ Body: { key?: string } }>('/key', async (req, reply) => {
    const key = req.body?.key?.trim()
    if (!key) return reply.code(400).send({ error: 'Key is required' })
    try {
      await listOneConnections(key)
    } catch (err) {
      return fail(reply, err)
    }
    saveOneSettings({ key, enabled: true })
    // Sessions read the MCP config when they spawn: replace the idle ones.
    await recycleSessions()
    return { ok: true }
  })

  // DELETE /key — unplug One entirely. Connections stay on One's side.
  app.delete('/key', async () => {
    saveOneSettings({ key: null })
    await recycleSessions()
    return { ok: true }
  })

  // PUT /enabled — keep the key but hide One from the agent (or bring it back).
  app.put<{ Body: { enabled?: boolean } }>('/enabled', async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be a boolean' })
    saveOneSettings({ enabled: req.body.enabled })
    await recycleSessions()
    return { ok: true }
  })

  // GET /connections — the apps connected in the One account.
  app.get('/connections', async (_req, reply) => {
    try {
      return await listOneConnections()
    } catch (err) {
      return fail(reply, err)
    }
  })

  // DELETE /connections/:id — revoke a connection on One. Not undoable.
  app.delete<{ Params: { id: string } }>('/connections/:id', async (req, reply) => {
    try {
      await deleteOneConnection(req.params.id)
      return { ok: true }
    } catch (err) {
      return fail(reply, err)
    }
  })

  // GET /catalog — every platform One can connect.
  app.get('/catalog', async (_req, reply) => {
    try {
      return await oneCatalogue()
    } catch (err) {
      return fail(reply, err)
    }
  })
}
