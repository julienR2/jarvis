import type { FastifyInstance } from 'fastify'
import { getDb } from '../db.js'
import { listRuns, stopRun } from '../runs.js'
import { fireCron } from '../crons.js'
import type { CronRow, RunRow, RunStatus } from '../types.js'

const RUN_STATUSES: RunStatus[] = ['running', 'needs_you', 'done', 'error', 'stopped', 'interrupted']

/** `<started_at>:<seq>`, as the client got it from the last row of the previous page. */
function parseCursor(raw?: string): { startedAt: number; seq: number } | undefined {
  if (!raw) return undefined
  const [a, b] = raw.split(':').map(Number)
  return Number.isFinite(a) && Number.isFinite(b) ? { startedAt: a, seq: b } : undefined
}

export async function runRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  /**
   * Recent runs, newest first. `conversation_id` scopes it to one chat — which
   * is how the chat renders the "ran outside this chat's memory" marker without
   * a request per message.
   */
  app.get('/', auth, async (req) => {
    const q = req.query as {
      conversation_id?: string
      /** Comma-separated. */
      status?: string
      kind?: string
      section_id?: string
      since?: string
      before?: string
      limit?: string
    }
    const statuses = (q.status ?? '')
      .split(',')
      .filter((s): s is RunStatus => RUN_STATUSES.includes(s as RunStatus))
    return listRuns({
      conversationId: q.conversation_id,
      statuses: statuses.length ? statuses : undefined,
      kind: q.kind === 'cron' || q.kind === 'webhook' ? q.kind : undefined,
      sectionId: q.section_id || undefined,
      since: q.since ? Number(q.since) : undefined,
      before: parseCursor(q.before),
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

  /**
   * Fire the run's source again. Crons only: a webhook fire is meaningless
   * without the payload that triggered it, and that is not kept.
   */
  app.post<{ Params: { id: string } }>('/:id/retry', auth, async (req, reply) => {
    const run = getDb()
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(req.params.id) as RunRow | undefined
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    if (run.kind !== 'cron') {
      return reply.code(400).send({ error: 'Only a cron can be re-fired; a webhook needs its original payload' })
    }
    if (!run.source_id) return reply.code(410).send({ error: 'The cron this came from is gone' })
    const entry = getDb().prepare('SELECT * FROM crons WHERE id = ?').get(run.source_id) as CronRow | undefined
    if (!entry) return reply.code(410).send({ error: 'The cron this came from is gone' })
    fireCron(entry)
    return { ok: true }
  })
}
