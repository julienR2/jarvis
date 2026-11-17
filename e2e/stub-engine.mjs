/**
 * A stand-in for the engine, for the duration of an e2e run.
 *
 * The suite is UI-only: it never runs a turn and so never needs a `claude`
 * process. But several pages still ask the backend something the backend can
 * only answer by asking the engine — "is this conversation running", deciding
 * a parked approval. With no engine there, the backend answers 502 and the
 * console guard fails the test for a reason that has nothing to do with the page.
 *
 * So: the smallest server that says "nothing is running, nothing is installed".
 * Plain node, no dependencies, no state. Anything not listed gets `{ok: true}`
 * and a line on stderr — if a spec starts depending on a real engine answer,
 * that line in results is where it shows up.
 */
import { createServer } from 'http'

const PORT = Number(process.env.PORT || 3110)

// [path, body, status]. Each answer is the truth about a server that holds no
// sessions — which is what the specs assert on: denying a seeded approval finds
// no session to deliver it to, and the UI says the run is no longer waiting.
const ROUTES = [
  [/^\/running\//, { running: false }, 200],
  [/^\/status$/, { sessions: [], conversations: [] }, 200],
  [/^\/answer\//, { error: 'no session holds this prompt' }, 404],
  // Nothing to fork from: the thread starts fresh, as it would on a real
  // engine whose transcript is gone.
  [/^\/fork$/, { error: 'no such session' }, 404],
  // A few of each kind, for the composer's `/` menu.
  [/^\/commands$/, {
    commands: [
      { name: 'gmail', description: 'Read, search, and send Gmail emails.', argumentHint: '', builtin: false },
      { name: 'todo', description: "Manage the user's personal todo lists.", argumentHint: '', builtin: false },
      { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', builtin: true },
      { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
    ],
  }, 200],
]

// The speech service, too (the backend's STT_URL points here): every
// recording says the same line, after a beat long enough for the composer's
// "Transcribing…" to be seen — and for a spec to tell whether the bubble waited
// for it. A dictation is held to the same offsets the real one checks.
const TRANSCRIPT = 'Voice note from the e2e microphone'
const ASR_DELAY_MS = 1500
const dictations = new Map()

const ASK_ANSWER = 'Answer from the stub engine'
const prompts = new Map()

// A local model server too (Settings → Connection → Local points here): the
// OpenAI-compatible endpoints llama-server answers. It streams a fixed answer
// that says how much it was sent, and keeps every request for the specs to
// read back (`/__local/requests`) — what a private chat sent, and that it was
// sent here and not to the engine. The window is small, so "too long" is
// reachable with a few kilobytes; /tokenize counts words, so it is exact.
const LOCAL_MODEL = 'stub-gemma'
const LOCAL_CTX = 4096
const LOCAL_TITLE = 'Stub private title'
const localRequests = []

function localServer(req, res, path) {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (path === '/v1/models') return json(200, { data: [{ id: LOCAL_MODEL, object: 'model', meta: { n_ctx: LOCAL_CTX * 4, n_ctx_train: 131072 } }] })
  // The window one request gets — what Jarvis must use over meta.n_ctx above.
  if (path === '/props') return json(200, { default_generation_settings: { n_ctx: LOCAL_CTX } })
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { /* empty */ }
    if (path === '/tokenize') return json(200, { tokens: String(body.content ?? '').split(/\s+/).filter(Boolean).map(() => 1) })
    localRequests.push(body)
    const msgs = body.messages ?? []
    // Titles ask for one without streaming.
    if (!body.stream) return json(200, { choices: [{ message: { role: 'assistant', content: body.max_tokens === 1 ? 'ok' : LOCAL_TITLE } }] })
    const last = msgs[msgs.length - 1]?.content ?? ''
    const answer = `Local answer: I was sent ${msgs.length} messages, the last one ${last.length} characters long.`
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const words = answer.split(' ')
    // A long prompt is "read" slowly, with llama-server's progress events, so
    // a spec can watch the Reading… status: ~4 s for anything past 1500 words.
    const total = msgs.reduce((n, m) => n + String(m.content).split(/\s+/).filter(Boolean).length, 0)
    const steps = body.return_progress && total > 1500 ? 8 : 0
    // Progress first, one event every 16 ticks (~0.5 s), then the words.
    let reading = steps * 16
    let i = 0
    const tick = setInterval(() => {
      if (reading > 0) {
        if (reading % 16 === 0) {
          const step = steps - reading / 16
          res.write(`data: ${JSON.stringify({ choices: [], prompt_progress: { total, cache: 0, processed: Math.round((total * step) / steps), time_ms: step * 500 } })}\n\n`)
        }
        reading--
        return
      }
      if (i < words.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: (i ? ' ' : '') + words[i] } }] })}\n\n`)
        i++
        return
      }
      clearInterval(tick)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: words.length } })}\n\n`)
      res.end('data: [DONE]\n\n')
    }, 30)
  })
}

createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const dictation = path.match(/^\/dictation\/([^/]+)(\/finish)?$/)
  if (dictation) {
    const [, id, finish] = dictation
    const url = new URL(req.url, 'http://localhost')
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'DELETE') {
      dictations.delete(id)
      req.resume()
      return json(200, { ok: true })
    }
    if (finish) {
      req.resume()
      const received = dictations.get(id) ?? 0
      if (received !== Number(url.searchParams.get('length'))) return json(409, { received })
      setTimeout(() => json(200, { transcript: TRANSCRIPT }), ASR_DELAY_MS)
      return
    }
    let size = 0
    req.on('data', (c) => { size += c.length })
    req.on('end', () => {
      const offset = Number(url.searchParams.get('offset'))
      const received = dictations.get(id) ?? 0
      if (offset <= received && offset + size > received) dictations.set(id, offset + size)
      json(200, { received: dictations.get(id) ?? 0 })
    })
    return
  }
  if (['/v1/models', '/v1/chat/completions', '/tokenize', '/props'].includes(path)) return localServer(req, res, path)
  if (path === '/__local/requests') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ requests: localRequests }))
    return
  }
  if (path === '/asr') {
    req.resume()
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(TRANSCRIPT)
    }, ASR_DELAY_MS)
    return
  }
  // An app's `jarvis.ask` runs as a one-shot session keyed `ask-…`: answer
  // it, so the bridge can be checked end to end.
  if (path.startsWith('/stream/ask-')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ type: 'done', result: ASK_ANSWER })}\n\ndata: {"type":"end"}\n\n`)
    return
  }
  // The last prompt sent for each conversation, for specs that check what
  // the backend put around the person's message.
  if (req.method === 'POST' && path === '/message') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try { const m = JSON.parse(body); prompts.set(m.conversationId, m.prompt) } catch { /* not ours to judge */ }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, queued: false }))
    })
    return
  }
  if (path.startsWith('/__prompt/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ prompt: prompts.get(path.slice('/__prompt/'.length)) ?? null }))
    return
  }
  const match = ROUTES.find(([re]) => re.test(path))
  if (!match) console.error(`[stub-engine] unhandled ${req.method} ${path} → {ok:true}`)
  const [, body, status] = match ?? [null, { ok: true }, 200]
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}).listen(PORT, '127.0.0.1', () => console.log(`[stub-engine] :${PORT}`))
