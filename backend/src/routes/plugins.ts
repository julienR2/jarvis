// Claude Code plugin marketplaces, managed from the settings UI.
//
// Thin JWT-gated pass-through: the engine container owns the `claude` binary
// and CLAUDE_CONFIG_DIR, so it runs the actual commands (see engine/plugins.ts).
// Everything here does is authenticate the caller and forward.

import type { FastifyInstance } from 'fastify'
import { pluginRequest } from '../engine.js'

export async function pluginRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  async function forward(reply: any, run: () => Promise<unknown>) {
    try {
      return await run()
    } catch (err: any) {
      // The engine has no watch mode, so a fresh backend can talk to an engine
      // that predates these routes. Say so instead of leaking a bare 404.
      if (err?.statusCode === 404) {
        return reply.code(503).send({
          error:
            'The engine does not expose plugin management yet — restart the engine container to pick up the new build.',
        })
      }
      // Other 4xx come from the CLI (bad repo, unknown plugin) and carry a
      // useful message; anything else is the engine being unreachable.
      const code = err?.statusCode >= 400 && err?.statusCode < 500 ? 400 : 502
      return reply.code(code).send({ error: err?.message ?? 'Plugin command failed' })
    }
  }

  // GET / — marketplaces + installed plugins + what's available to install
  app.get('/', auth, async (_req, reply) =>
    forward(reply, () => pluginRequest('GET', '')),
  )

  // ── Marketplaces ───────────────────────────────────────────────────────────

  app.post<{ Body: { source?: string } }>('/marketplaces', auth, async (req, reply) =>
    forward(reply, () => pluginRequest('POST', '/marketplaces', req.body ?? {})),
  )

  app.post<{ Params: { name: string } }>(
    '/marketplaces/:name/update',
    auth,
    async (req, reply) =>
      forward(reply, () =>
        pluginRequest('POST', `/marketplaces/${encodeURIComponent(req.params.name)}/update`),
      ),
  )

  app.delete<{ Params: { name: string } }>('/marketplaces/:name', auth, async (req, reply) =>
    forward(reply, () =>
      pluginRequest('DELETE', `/marketplaces/${encodeURIComponent(req.params.name)}`),
    ),
  )

  // ── Plugins ────────────────────────────────────────────────────────────────

  app.post<{ Body: { pluginId?: string } }>('/install', auth, async (req, reply) =>
    forward(reply, () => pluginRequest('POST', '/install', req.body ?? {})),
  )

  app.post<{ Params: { pluginId: string }; Body: { enabled?: boolean } }>(
    '/:pluginId/enabled',
    auth,
    async (req, reply) =>
      forward(reply, () =>
        pluginRequest('POST', `/${encodeURIComponent(req.params.pluginId)}/enabled`, req.body ?? {}),
      ),
  )

  app.post<{ Params: { pluginId: string }; Body: { alwaysOn?: boolean } }>(
    '/:pluginId/always-on',
    auth,
    async (req, reply) =>
      forward(reply, () =>
        pluginRequest(
          'POST',
          `/${encodeURIComponent(req.params.pluginId)}/always-on`,
          req.body ?? {},
        ),
      ),
  )

  app.post<{ Params: { pluginId: string } }>('/:pluginId/update', auth, async (req, reply) =>
    forward(reply, () =>
      pluginRequest('POST', `/${encodeURIComponent(req.params.pluginId)}/update`),
    ),
  )

  app.get<{ Params: { pluginId: string } }>('/:pluginId/details', auth, async (req, reply) =>
    forward(reply, () =>
      pluginRequest('GET', `/${encodeURIComponent(req.params.pluginId)}/details`),
    ),
  )

  app.delete<{ Params: { pluginId: string } }>('/:pluginId', auth, async (req, reply) =>
    forward(reply, () => pluginRequest('DELETE', `/${encodeURIComponent(req.params.pluginId)}`)),
  )
}
