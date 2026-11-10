import type { FastifyInstance } from 'fastify'
import { DICTATION_ID_RE, appendDictation, dropDictation, finishDictation, type DictationAnswer } from '../stt.js'

/**
 * Dictation, streamed while it is spoken: the browser sends 16 kHz PCM a
 * second or so at a time, each request from the byte offset the speech
 * service last said it holds, and this passes it through. Turning it into a
 * message goes through POST /api/conversations/:id/dictation; putting it in
 * the composer, through finish here.
 */
export function dictationRoutes(app: FastifyInstance, _opts: unknown, done: () => void): void {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_req, body, next) => next(null, body))

  const auth = { onRequest: [app.authenticate] }
  // A request a second while recording, and a burst of them catching up
  // after the connection comes back: more than the global limit allows.
  const often = { ...auth, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }

  function relay(reply: { code(n: number): { send(b: unknown): unknown } }, work: Promise<DictationAnswer>) {
    return work.then(
      (answer) => reply.code(answer.status).send(answer.body),
      (err: Error) => reply.code(502).send({ error: err.message }),
    )
  }

  app.put<{ Params: { id: string }; Querystring: { offset?: string }; Body: Buffer }>('/:id', often, async (req, reply) => {
    const offset = Number(req.query.offset)
    if (!DICTATION_ID_RE.test(req.params.id) || !Number.isInteger(offset) || !Buffer.isBuffer(req.body)) {
      return reply.code(400).send({ error: 'A dictation id, an offset and raw audio are required' })
    }
    return relay(reply, appendDictation(req.params.id, offset, req.body))
  })

  app.post<{ Params: { id: string }; Querystring: { length?: string } }>('/:id/finish', often, async (req, reply) => {
    const length = Number(req.query.length)
    if (!DICTATION_ID_RE.test(req.params.id) || !Number.isInteger(length)) {
      return reply.code(400).send({ error: 'A dictation id and its length are required' })
    }
    return relay(reply, finishDictation(req.params.id, length))
  })

  app.delete<{ Params: { id: string } }>('/:id', auth, async (req, reply) => {
    if (!DICTATION_ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'Bad dictation id' })
    await dropDictation(req.params.id)
    return { ok: true }
  })

  done()
}
