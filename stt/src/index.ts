import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadModel, ready, SAMPLE_RATE } from './model.ts'
import { Segmenter, transcribeAll } from './segments.ts'

/**
 * Local speech-to-text for Jarvis.
 *
 *   PUT  /dictation/:id?offset=N    raw 16 kHz mono PCM16, from byte N
 *   POST /dictation/:id/finish?length=N
 *   DELETE /dictation/:id
 *   POST /asr                       a whole file, any format (Whisper-compatible)
 *
 * A dictation streams in while the person speaks and is transcribed as it
 * comes, so stopping leaves only the last few seconds to do. The client keeps
 * the whole recording and sends from whatever offset this side says it has:
 * a dropped request, a lost connection, even this service restarting, all
 * end the same way — the client sends again from there.
 */

const PORT = Number(process.env.PORT) || 9000
const MAX_BODY = 200 * 1024 * 1024
const ID_RE = /^[0-9a-f-]{8,64}$/i
// Long enough to sit through a phone losing its connection for a while.
const IDLE_MS = 30 * 60_000

interface Dictation {
  received: number
  segmenter: Segmenter
  /** Set once finished, so a client that missed the answer can ask again. */
  result?: Promise<string>
  touched: number
}

const dictations = new Map<string, Dictation>()

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS
  for (const [id, d] of dictations) if (d.touched < cutoff) dictations.delete(id)
}, 60_000).unref()

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type })
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body))
}

/** Any audio or video file to 16 kHz mono PCM16. From a file, not a pipe: an
 *  mp4/m4a keeps its index at the end, which ffmpeg cannot seek to in a pipe. */
async function decodeFile(data: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'stt-'))
  const input = path.join(dir, 'input')
  try {
    await writeFile(input, data)
    return await new Promise<Buffer>((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'])
      const out: Buffer[] = []
      let err = ''
      ff.stdout.on('data', (c: Buffer) => out.push(c))
      ff.stderr.on('data', (c: Buffer) => (err += c))
      ff.on('error', reject)
      ff.on('exit', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`Could not read the audio: ${err.trim() || code}`))))
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The file out of a multipart upload (field `audio_file`, as Whisper's API
 *  takes it), or the body itself when it is not multipart. */
async function uploadedAudio(req: http.IncomingMessage, body: Buffer): Promise<Buffer> {
  const type = req.headers['content-type'] ?? ''
  if (!type.startsWith('multipart/form-data')) return body
  const form = await new Response(new Uint8Array(body), { headers: { 'content-type': type } }).formData()
  const file = form.get('audio_file') ?? form.get('file')
  if (!file || typeof file === 'string') throw new Error('No audio file (multipart field "audio_file")')
  return Buffer.from(await file.arrayBuffer())
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://stt')
  const parts = url.pathname.split('/').filter(Boolean)

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, ready() ? 200 : 503, { ready: ready() })
  }
  if (!ready()) return send(res, 503, { error: 'The speech model is still loading' })

  if (req.method === 'POST' && url.pathname === '/asr') {
    const pcm = await decodeFile(await uploadedAudio(req, await readBody(req)))
    const transcript = await transcribeAll(pcm)
    return url.searchParams.get('output') === 'json'
      ? send(res, 200, { text: transcript })
      : send(res, 200, transcript, 'text/plain; charset=utf-8')
  }

  if (parts[0] !== 'dictation' || !parts[1] || !ID_RE.test(parts[1])) return send(res, 404, { error: 'Not found' })
  const id = parts[1]
  let d = dictations.get(id)

  if (req.method === 'PUT' && parts.length === 2) {
    const offset = Number(url.searchParams.get('offset'))
    const body = await readBody(req)
    if (!Number.isInteger(offset) || offset < 0 || offset % 2 || body.length % 2) {
      return send(res, 400, { error: 'offset and length must be whole PCM16 samples' })
    }
    if (!d && offset === 0) {
      d = { received: 0, segmenter: new Segmenter(), touched: Date.now() }
      dictations.set(id, d)
    }
    // Anything but the continuation of what is here is answered with where
    // this side stands, and the client resumes from there.
    if (d && !d.result && offset <= d.received && offset + body.length > d.received) {
      d.segmenter.push(body.subarray(d.received - offset))
      d.received = offset + body.length
    }
    if (d) d.touched = Date.now()
    return send(res, 200, { received: d?.received ?? 0 })
  }

  if (req.method === 'POST' && parts[2] === 'finish') {
    const length = Number(url.searchParams.get('length'))
    if (!d || (!d.result && d.received !== length)) {
      return send(res, 409, { received: d?.received ?? 0 })
    }
    d.touched = Date.now()
    d.result ??= d.segmenter.finish()
    try {
      return send(res, 200, { transcript: await d.result })
    } catch (err) {
      dictations.delete(id)
      throw err
    }
  }

  if (req.method === 'DELETE' && parts.length === 2) {
    dictations.delete(id)
    return send(res, 200, { ok: true })
  }

  return send(res, 404, { error: 'Not found' })
}

http
  .createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      console.error('[stt]', err)
      if (!res.headersSent) send(res, 500, { error: err.message })
      else res.end()
    })
  })
  .listen(PORT, () => console.log(`[stt] listening on ${PORT}`))

loadModel().catch((err) => {
  console.error('[stt] could not load the model:', err)
  process.exit(1)
})
