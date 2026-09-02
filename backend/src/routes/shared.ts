/**
 * Resolving a share link.
 *
 * This is all that remains of a once-parallel read-only API. The shared view is
 * now the real chat UI with the sidebar and actions removed, so it calls the
 * same conversation endpoints the owner's UI does, authenticated by the share
 * token (see share-access.ts). A second implementation would only have drifted.
 *
 * What is still needed is this one hop: a visitor arrives holding a token and
 * nothing else, and has to learn which conversation it opens.
 */
import type { FastifyInstance } from 'fastify'
import { resolveShareToken } from '../share-access.js'

export async function sharedRoutes(app: FastifyInstance) {
  // GET /:token — the conversation this link opens, and what it may do with it.
  app.get<{ Params: { token: string } }>(
    '/:token',
    // Unauthenticated and internet-facing: capped well below the global limit.
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const access = resolveShareToken(req.params.token)
      if (!access) return reply.code(404).send({ error: 'Not found' })
      return {
        id: access.conv.id,
        title: access.conv.title,
        mode: access.mode,
      }
    },
  )
}
