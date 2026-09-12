import type { FastifyInstance } from 'fastify'
import { getDb } from '../db.js'
import { listRuns, stopRun } from '../runs.js'
import type { RunRow, RunStatus } from '../types.js'

const RUN_STATUSES: RunStatus[] = ['running', 'done', 'error', 'stopped', 'interrupted']

export async function runRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  /**
   * Recent runs, newest first. `conversation_id` scopes it to one chat — which
   * is how the chat renders the "ran outside this chat's memory" marker without
   * a request per message.
   */
  app.get('/', auth, async (req) => {
    const q = req.query as { conversation_id?: string; status?: string; limit?: string }
    const status = RUN_STATUSES.includes(q.status as RunStatus)
      ? (q.status as RunStatus)
      : undefined
    return listRuns({
      conversationId: q.conversation_id,
      status,
      limit: q.limit ? Number(q.limit) : undefined,
    })
  })

  app.get<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    const run = getDb()
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(req.params.id) as RunRow | undefined
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    return run
  })

  /**
   * Stop one run. Scoped to a single run rather than to the conversation
   * because several can be in flight in the same chat at once — two fires of
   * the same webhook, or a cron landing while another still works.
   *
   * `stopped: false` means it had already finished, which is not an error: the
   * button was simply a moment late.
   */
  app.post<{ Params: { id: string } }>('/:id/stop', auth, async (req, reply) => {
    const run = getDb()
      .prepare('SELECT id FROM runs WHERE id = ?')
      .get(req.params.id) as { id: string } | undefined
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    return { stopped: await stopRun(req.params.id) }
  })
}
