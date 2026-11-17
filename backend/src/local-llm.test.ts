// Unit tests for the Local provider. Run: npm --prefix backend test
//
// The OpenAI-compatible server is mocked with a plain http server, so nothing
// here needs a model — or reaches anything outside this process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  ContextOverflowError,
  contextOf,
  estimateTokens,
  fitToContext,
  inlineAttachment,
  isLocalModel,
  listLocalModels,
  normalizeBaseUrl,
  replyReserve,
  serverModelId,
  streamChat,
  tokenCounter,
  verifyLocal,
  type ChatMessage,
  type TokenCounter,
} from './local-llm.js'
import { isGatewayModel } from './models.js'
import { privateSql } from './private.js'

const FIXTURE_ZIP = new URL('./__fixtures__/chat-export.zip', import.meta.url).pathname

/** A counter where every character is a token: budgets become easy to reason about. */
const chars: TokenCounter = async (texts) => texts.map((t) => t.length)

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, server }
}

// ── Ids and routing ─────────────────────────────────────────────────────────

test('local ids are their own route, before the gateway rule', () => {
  assert.equal(isLocalModel('local:gemma-4-e4b'), true)
  assert.equal(isLocalModel('gemma-4-e4b'), false)
  assert.equal(isLocalModel(null), false)
  // A local server may name a model with a slash; it must not read as a gateway id.
  assert.equal(isGatewayModel('local:hf.co/org/model'), false)
  assert.equal(isGatewayModel('openai/gpt-5.6'), true)
  assert.equal(isGatewayModel('claude-opus-5-5'), false)
  assert.equal(serverModelId('local:hf.co/org/model'), 'hf.co/org/model')
})

test('base URLs are normalised to the server root', () => {
  assert.equal(normalizeBaseUrl('http://llm:8080/'), 'http://llm:8080')
  assert.equal(normalizeBaseUrl(' http://llm:8080/v1 '), 'http://llm:8080')
  assert.equal(normalizeBaseUrl('http://llm:8080/v1/'), 'http://llm:8080')
})

// ── Context windows ─────────────────────────────────────────────────────────

test('the live window is read from the shapes common servers use', () => {
  // llama-server: n_ctx is what it allocated, n_ctx_train what the model was trained on.
  assert.equal(contextOf({ id: 'g', meta: { n_ctx: 32768, n_ctx_train: 131072 } }), 32768)
  assert.equal(contextOf({ id: 'm', loaded_context_length: 16384, max_context_length: 131072 }), 16384)
  assert.equal(contextOf({ id: 'x', context_length: 8192 }), 8192)
  assert.equal(contextOf({ id: 'y' }), null)
})

test('the reply keeps a quarter of the window, within bounds', () => {
  assert.equal(replyReserve(32768), 4096)
  assert.equal(replyReserve(8192), 2048)
  assert.equal(replyReserve(1024), 512)
})

test('fitToContext keeps everything when it fits', async () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'a'.repeat(100) },
    { role: 'assistant', content: 'b'.repeat(100) },
  ]
  const b = await fitToContext({ system: 'sys', history, current: 'q', contextWindow: 4096, count: chars })
  assert.equal(b.dropped, 0)
  assert.deepEqual(b.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(b.maxTokens, replyReserve(4096))
})

test('fitToContext drops the oldest history, and never opens on an orphaned answer', async () => {
  // Window 2048 → reserve 512 → budget 1536 (each message also costs 8 tokens of template).
  const history: ChatMessage[] = [
    { role: 'user', content: 'u'.repeat(600) },
    { role: 'assistant', content: 'a'.repeat(600) },
    { role: 'user', content: 'v'.repeat(300) },
    { role: 'assistant', content: 'b'.repeat(300) },
  ]
  const b = await fitToContext({ system: 's', history, current: 'q'.repeat(100), contextWindow: 2048, count: chars })
  // 600+300+300+100 would fit only without the first question: then the kept
  // history would start on its answer, which is dropped too.
  assert.equal(b.dropped, 2)
  assert.deepEqual(b.messages.map((m) => m.content[0]), ['s', 'v', 'b', 'q'])
  assert.ok(b.promptTokens <= 2048 - replyReserve(2048))
})

test('fitToContext refuses a message that cannot fit, with numbers', async () => {
  await assert.rejects(
    fitToContext({ system: 's', history: [], current: 'x'.repeat(10_000), contextWindow: 8192, count: chars }),
    (err: Error) => err instanceof ContextOverflowError && /10,008 tokens/.test(err.message) && /8,192/.test(err.message),
  )
})

test('token counting uses /tokenize when the server has it, an estimate otherwise', async () => {
  const withTokenize = await serve((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ tokens: JSON.parse(body).content.split(' ') }))
    })
  })
  const without = await serve((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  try {
    assert.deepEqual(await tokenCounter({ baseUrl: withTokenize.url })(['one two three', 'four']), [3, 1])
    assert.deepEqual(await tokenCounter({ baseUrl: without.url })(['abcdefg']), [estimateTokens('abcdefg')])
  } finally {
    withTokenize.server.close()
    without.server.close()
  }
})

// ── The server ──────────────────────────────────────────────────────────────

test('models are listed with their window, from /props when /v1/models is silent', async () => {
  const { url, server } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'tiny' }] }))
    else if (req.url === '/props') res.end(JSON.stringify({ default_generation_settings: { n_ctx: 12288 } }))
    else res.end('{}')
  })
  try {
    assert.deepEqual(await listLocalModels({ baseUrl: url }, { fresh: true }), [
      { id: 'tiny', contextWindow: 12288, contextKnown: true },
    ])
  } finally {
    server.close()
  }
})

test("the window comes from /props first, then /v1/models, then the configured fallback — never a constant", async () => {
  let props: unknown = { default_generation_settings: { n_ctx: 131072 } }
  let meta: unknown = { n_ctx: 32768 }
  const { url, server } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'g', meta }] }))
    else if (req.url === '/props') res.end(JSON.stringify(props))
    else res.end('{}')
  })
  try {
    const list = (cfg: Parameters<typeof listLocalModels>[0]) => listLocalModels(cfg, { fresh: true })
    // Restarted with a bigger --ctx-size: the server's word is taken as is.
    assert.equal((await list({ baseUrl: url }))[0].contextWindow, 131072)
    props = {}
    assert.equal((await list({ baseUrl: url }))[0].contextWindow, 32768)
    meta = {}
    assert.deepEqual((await list({ baseUrl: url, contextWindow: 65536 }))[0], { id: 'g', contextWindow: 65536, contextKnown: false })
    assert.equal((await list({ baseUrl: url }))[0].contextWindow, 8192)
    // A configured fallback never overrides a window the server reports.
    props = { default_generation_settings: { n_ctx: 16384 } }
    assert.equal((await list({ baseUrl: url, contextWindow: 65536 }))[0].contextWindow, 16384)
  } finally {
    server.close()
  }
})

test('verification needs a model list and a working completion, and sends the key', async () => {
  const seen: string[] = []
  const { url, server } = await serve((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`)
    if (req.headers.authorization !== 'Bearer s3cret') {
      res.writeHead(401)
      return res.end('{"error":{"message":"bad key"}}')
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'tiny', meta: { n_ctx: 4096 } }] }))
    else res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    req.resume()
  })
  try {
    const ok = await verifyLocal({ baseUrl: url, apiKey: 's3cret' })
    assert.equal(ok.ok, true)
    assert.ok(seen.includes('POST /v1/chat/completions Bearer s3cret'))
    const bad = await verifyLocal({ baseUrl: url, apiKey: 'nope' })
    assert.equal(bad.ok, false)
    assert.match((bad as { error: string }).error, /refused the API key/)
    // A port that was just free: nothing listens there now.
    const gone = await serve(() => {})
    await new Promise((r) => gone.server.close(r))
    const down = await verifyLocal({ baseUrl: gone.url })
    assert.match((down as { error: string }).error, /isn't reachable/)
  } finally {
    server.close()
  }
})

test('a streamed answer is reassembled across split SSE frames, with usage and tool calls', async () => {
  let request: any
  const frames = [
    { choices: [], prompt_progress: { total: 5000, cache: 1000, processed: 3000, time_ms: 20000 } },
    { choices: [{ delta: { role: 'assistant', content: 'Bon' } }] },
    { choices: [{ delta: { content: 'jour' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":1}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } },
  ]
  const { url, server } = await serve((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      request = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const all = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n'
      // Cut mid-frame, so the parser has to carry partial lines over.
      for (let i = 0; i < all.length; i += 17) {
        res.write(all.slice(i, i + 17))
        await new Promise((r) => setTimeout(r, 1))
      }
      res.end()
    })
  })
  try {
    const deltas: string[] = []
    const progress: unknown[] = []
    const r = await streamChat({ baseUrl: url }, {
      model: 'local:tiny',
      messages: [{ role: 'user', content: 'salut' }],
      maxTokens: 50,
      onDelta: (t) => deltas.push(t),
      onProgress: (p) => progress.push(p),
    })
    assert.equal(request.return_progress, true)
    assert.deepEqual(progress, [{ total: 5000, cached: 1000, processed: 3000, ms: 20000 }])
    assert.equal(request.model, 'tiny')
    assert.equal(request.stream, true)
    assert.equal(request.max_tokens, 50)
    assert.equal('tools' in request, false)
    assert.deepEqual(deltas, ['Bon', 'jour'])
    assert.equal(r.text, 'Bonjour')
    assert.equal(r.finishReason, 'stop')
    assert.deepEqual(r.usage, { prompt: 12, completion: 2 })
    assert.deepEqual(r.toolCalls, [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":1}' } }])
  } finally {
    server.close()
  }
})

test('a context error from the server reads as one', async () => {
  const { url, server } = await serve((req, res) => {
    req.resume()
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'the request exceeds the available context size' } }))
  })
  try {
    await assert.rejects(
      streamChat({ baseUrl: url }, { model: 'local:tiny', messages: [], maxTokens: 10 }),
      (err: Error) => err instanceof ContextOverflowError,
    )
  } finally {
    server.close()
  }
})

// ── Attachments ─────────────────────────────────────────────────────────────

test('text files go inline, a zip gives up its text, anything else is named not read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-llm-'))
  const txt = join(dir, 'a.txt')
  writeFileSync(txt, '﻿hello\n')
  assert.equal(inlineAttachment({ originalName: 'notes.txt', mimetype: 'text/plain', path: txt }), '<file name="notes.txt">\nhello\n</file>')

  const zipped = inlineAttachment({ originalName: 'export.zip', mimetype: 'application/zip', path: FIXTURE_ZIP })
  assert.match(zipped, /<file name="export.zip › _chat.txt">/)
  assert.match(zipped, /On se retrouve à 18h devant la gare/)
  assert.match(zipped, /👍/)
  assert.doesNotMatch(zipped, /PHOTO\.jpg"|__MACOSX/)

  const png = join(dir, 'p.png')
  writeFileSync(png, Buffer.from([0x89, 0x50]))
  assert.match(inlineAttachment({ originalName: 'p.png', mimetype: 'image/png', path: png }), /can only read text/)
  assert.match(inlineAttachment({ originalName: 'gone.txt', mimetype: 'text/plain', path: join(dir, 'nope') }), /no longer on disk/)
})

// ── Privacy ─────────────────────────────────────────────────────────────────

test('a conversation is private once a local model has spoken in it, whatever it is set to now', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE conversations (id TEXT, model TEXT); CREATE TABLE messages (conversation_id TEXT, model TEXT);`)
  db.exec(`INSERT INTO conversations VALUES ('claude', 'claude-opus-5-5'), ('set-local', 'local:g'), ('was-local', 'claude-opus-5-5'), ('gw', 'openai/x');`)
  db.exec(`INSERT INTO messages VALUES ('claude', 'claude-opus-5-5'), ('was-local', 'local:g'), ('was-local', 'claude-opus-5-5'), ('gw', NULL);`)
  const rows = db.prepare(`SELECT c.id FROM conversations c WHERE ${privateSql('c')} ORDER BY c.id`).all() as { id: string }[]
  assert.deepEqual(rows.map((r) => r.id), ['set-local', 'was-local'])
})
