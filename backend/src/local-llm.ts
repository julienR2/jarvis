/**
 * The Local provider: any OpenAI-compatible server on the owner's own machine
 * (llama.cpp's llama-server, Ollama, LM Studio…).
 *
 * Not an agent. A local conversation never reaches the engine or the Claude
 * CLI: the backend sends Jarvis's own transcript of the conversation as an
 * OpenAI `messages` array and streams the answer back. The CLI would carry
 * ~30k tokens of system prompt, tools and skills before the first word
 * (docs/token-overhead.md), which is minutes of prompt reading on a home
 * server's iGPU, and a 4B model can't drive thirty tools anyway. What it can
 * do, and what this exists for, is read something private (a chat export, a
 * document) and answer questions about it without the content leaving the box.
 *
 * Model ids carry a `local:` prefix — `local:gemma-4-e4b` — which is what
 * routes them here. It is checked before the gateway's `/` rule everywhere ids
 * are routed by shape, since a local id may itself contain a slash
 * (`local:hf.co/org/model`).
 *
 * Tools are not wired up yet, but the turn is shaped for them: see runTurn.
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { extname } from 'path'
import { request as httpRequest, type IncomingMessage } from 'http'
import { request as httpsRequest } from 'https'
import { readSecrets } from './secrets.js'
import { textEntriesOfZip } from './zip.js'

export const LOCAL_PREFIX = 'local:'

/** Whether a model id is served by the local provider. */
export function isLocalModel(id?: string | null): boolean {
  return !!id && id.startsWith(LOCAL_PREFIX)
}

/** The id the server itself knows the model by. */
export function serverModelId(id: string): string {
  return isLocalModel(id) ? id.slice(LOCAL_PREFIX.length) : id
}

export interface LocalConfig {
  /** Server root, without a trailing slash or `/v1`. */
  baseUrl: string
  apiKey?: string
  /**
   * The window to assume when the server doesn't report one (Settings →
   * Connection → Local). Never overrides a window the server does report:
   * that is the one its requests are actually held to, and it changes when
   * the server is restarted with another `--ctx-size`.
   */
  contextWindow?: number
}

/**
 * `http://llm:8080`, `http://llm:8080/`, `http://llm:8080/v1` all name the same
 * server: OpenAI clients are usually configured with the `/v1` suffix, and
 * llama.cpp's own extras (/props, /tokenize) live at the root.
 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

/**
 * The configured server, or null when the feature is off. Stored with the
 * other provider secrets; the environment pre-seeds it for a headless install.
 * Never mirrored to the engine (secrets.ts): the agent has no use for it.
 */
export function localConfig(): LocalConfig | null {
  const s = readSecrets()
  const baseUrl = (typeof s.localBaseUrl === 'string' && s.localBaseUrl) || process.env.LOCAL_LLM_BASE_URL || ''
  if (!baseUrl) return null
  const apiKey = (typeof s.localApiKey === 'string' && s.localApiKey) || process.env.LOCAL_LLM_API_KEY || ''
  const ctx = Number(s.localContextWindow ?? process.env.LOCAL_LLM_CONTEXT_WINDOW)
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    ...(apiKey ? { apiKey } : {}),
    ...(Number.isFinite(ctx) && ctx > 0 ? { contextWindow: Math.floor(ctx) } : {}),
  }
}

function headers(cfg: LocalConfig, json = false): Record<string, string> {
  return {
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

// ── Models ──────────────────────────────────────────────────────────────────

export interface LocalModel {
  /** As the server names it, without the prefix. */
  id: string
  /** Tokens the server will hold for one request: prompt and answer together. */
  contextWindow: number
  /** Whether the window was reported by the server rather than assumed. */
  contextKnown: boolean
}

/**
 * When the server says nothing about its window and none is configured. Small
 * on purpose: assuming too much means a request the server rejects after
 * reading the whole prompt; assuming too little only trims history that would
 * have fit.
 */
export const FALLBACK_CONTEXT = 8192

/** The window to assume for a server that reports none. */
const assumedContext = (cfg: LocalConfig) => cfg.contextWindow ?? FALLBACK_CONTEXT

/**
 * Read the server's window from the shapes the common servers use:
 * llama-server puts the live `n_ctx` in `meta` (`n_ctx_train` is what the model
 * was trained on, not what the server allocated — the wrong number to trust);
 * LM Studio reports `loaded_context_length` / `max_context_length`; others
 * `context_length` or `context_window`.
 */
export function contextOf(entry: Record<string, unknown>): number | null {
  const meta = (entry.meta ?? {}) as Record<string, unknown>
  for (const v of [
    meta.n_ctx,
    entry.loaded_context_length,
    entry.context_length,
    entry.context_window,
    entry.max_context_length,
  ]) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

let modelCache: { key: string; at: number; models: LocalModel[] } | null = null
// Short: a local server swaps models more readily than a gateway's catalogue
// changes, and asking it is one cheap request on the local network.
const MODEL_CACHE_MS = 60_000

export async function listLocalModels(cfg: LocalConfig, opts: { fresh?: boolean } = {}): Promise<LocalModel[]> {
  const key = `${cfg.baseUrl}|${cfg.apiKey ?? ''}`
  if (!opts.fresh && modelCache?.key === key && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return modelCache.models
  }
  const res = await localFetch(cfg, '/v1/models', { headers: headers(cfg), signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(await describeFailure(cfg, res))
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
  const entries = (body.data ?? []).filter((m) => typeof m.id === 'string' && m.id)

  // Never a constant: the window is whatever the server was started with
  // (`--ctx-size`), and that changes. llama-server's /props is asked first —
  // `default_generation_settings.n_ctx` is the window one request gets, which
  // with several slots is a share of the `meta.n_ctx` /v1/models reports. It
  // describes the one model the server runs, so it is only trusted when one is
  // listed. Then what /v1/models says, then the configured fallback.
  const propsCtx = entries.length === 1 ? await propsContext(cfg) : null
  const models: LocalModel[] = []
  for (const m of entries) {
    const ctx = propsCtx ?? contextOf(m)
    models.push({ id: String(m.id), contextWindow: ctx ?? assumedContext(cfg), contextKnown: ctx !== null })
  }
  modelCache = { key, at: Date.now(), models }
  return models
}

async function propsContext(cfg: LocalConfig): Promise<number | null> {
  try {
    const res = await fetch(`${cfg.baseUrl}/props`, { headers: headers(cfg), signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const body = (await res.json()) as { default_generation_settings?: { n_ctx?: number } }
    const n = Number(body.default_generation_settings?.n_ctx)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** One model's details, or a stand-in when the server no longer lists it. */
export async function localModelInfo(cfg: LocalConfig, id: string): Promise<LocalModel> {
  const name = serverModelId(id)
  const models = await listLocalModels(cfg).catch(() => [] as LocalModel[])
  return models.find((m) => m.id === name) ?? { id: name, contextWindow: assumedContext(cfg), contextKnown: false }
}

/** Forget the listing, so the next turn reads the window again (after the server refused one as too long). */
export function forgetLocalModels(): void {
  modelCache = null
}

/**
 * Check a server before saving it, like the other two providers: it must list
 * at least one model and answer a one-token request with it. The request is
 * tiny, but a server that runs one request at a time makes it wait behind
 * whatever is in flight — hence the long timeout.
 */
export async function verifyLocal(cfg: LocalConfig): Promise<{ ok: true; models: LocalModel[] } | { ok: false; error: string }> {
  let models: LocalModel[]
  try {
    models = await listLocalModels(cfg, { fresh: true })
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
  if (models.length === 0) return { ok: false, error: 'The server answered but lists no models.' }
  try {
    const res = await localFetch(cfg, '/v1/chat/completions', {
      method: 'POST',
      headers: headers(cfg, true),
      body: JSON.stringify({
        model: models[0].id,
        messages: [{ role: 'user', content: 'Reply with: ok' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return { ok: false, error: await describeFailure(cfg, res) }
    await res.json()
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
  return { ok: true, models }
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** fetch, with "nothing is listening" turned into a sentence about the server. */
async function localFetch(cfg: LocalConfig, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${cfg.baseUrl}${path}`, init)
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err
    const code = err?.cause?.code ?? err?.code
    throw new Error(
      code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH'
        ? `The local model server at ${cfg.baseUrl} isn't reachable (${code}).`
        : `Couldn't reach the local model server at ${cfg.baseUrl}: ${err?.cause?.message ?? err?.message ?? err}`,
    )
  }
}

export class ContextOverflowError extends Error {}

async function describeFailure(cfg: LocalConfig, res: Response): Promise<string> {
  const detail = await res.text().catch(() => '')
  let message = detail.slice(0, 300)
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } | string }
    const inner = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
    if (inner) message = inner
  } catch {
    /* not JSON */
  }
  if (res.status === 401 || res.status === 403) return `The local model server at ${cfg.baseUrl} refused the API key (${res.status}).`
  if (res.status === 503) return `The local model server is still loading its model — try again in a moment.${message ? ` (${message})` : ''}`
  return message || `The local model server returned ${res.status}.`
}

// ── Token budget ────────────────────────────────────────────────────────────

/**
 * Count tokens the way the server will. llama-server has /tokenize, which is
 * exact and cheap (no slot, no model pass); anything else gets an estimate
 * deliberately on the high side — 3 characters a token undercounts English
 * slightly and fits French and chat exports with their emoji and timestamps.
 */
export type TokenCounter = (texts: string[]) => Promise<number[]>

export const estimateTokens = (text: string): number => Math.ceil(text.length / 3)

const tokenizeSupport = new Map<string, boolean>()

export function tokenCounter(cfg: LocalConfig): TokenCounter {
  return async (texts) => {
    if (tokenizeSupport.get(cfg.baseUrl) !== false) {
      try {
        const counts: number[] = []
        // One after another: a single-slot server is happier with a queue than
        // a burst, and tokenizing is milliseconds either way.
        for (const content of texts) {
          const res = await fetch(`${cfg.baseUrl}/tokenize`, {
            method: 'POST',
            headers: headers(cfg, true),
            body: JSON.stringify({ content }),
            signal: AbortSignal.timeout(15_000),
          })
          if (!res.ok) throw new Error(String(res.status))
          const body = (await res.json()) as { tokens?: unknown[] }
          if (!Array.isArray(body.tokens)) throw new Error('no tokens')
          counts.push(body.tokens.length)
        }
        tokenizeSupport.set(cfg.baseUrl, true)
        return counts
      } catch {
        tokenizeSupport.set(cfg.baseUrl, false)
      }
    }
    return texts.map(estimateTokens)
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  // Tool calling, for when the loop in runTurn grows one. Unused in v1.
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Per-message overhead of the chat template (role markers, separators). */
const TEMPLATE_TOKENS = 8

export interface Budget {
  messages: ChatMessage[]
  /** History messages left out, oldest first, to make room. */
  dropped: number
  /** What the prompt will take, by the counter's reckoning. */
  promptTokens: number
  /** The answer's allowance: what is left of the window, capped. */
  maxTokens: number
}

/**
 * The answer's share of the window: a quarter, between 512 and 4096 tokens.
 * At ~11 tokens/s on a home iGPU, 4096 is six minutes of writing — more than
 * any answer about a document needs, and every token reserved here is one the
 * document itself can't use.
 */
export function replyReserve(contextWindow: number): number {
  return Math.max(512, Math.min(4096, Math.floor(contextWindow / 4)))
}

/**
 * Fit a turn into the model's window: the system prompt and the new message
 * always go; history goes newest-first for as long as it fits. When even the
 * new message can't fit, it is refused with numbers rather than sent to fail —
 * a local server either rejects the request after reading the whole prompt or,
 * worse, silently truncates it.
 */
export async function fitToContext(opts: {
  system: string
  history: ChatMessage[]
  current: string
  contextWindow: number
  count: TokenCounter
}): Promise<Budget> {
  const reserve = replyReserve(opts.contextWindow)
  const budget = opts.contextWindow - reserve
  const [systemTokens, currentTokens, ...historyTokens] = (
    await opts.count([opts.system, opts.current, ...opts.history.map((m) => m.content)])
  ).map((n) => n + TEMPLATE_TOKENS)

  const fixed = systemTokens + currentTokens
  if (fixed > budget) {
    throw new ContextOverflowError(
      `This message is too long for the local model: about ${fmt(currentTokens)} tokens, ` +
        `and its context window is ${fmt(opts.contextWindow)} tokens, ${fmt(reserve)} of them kept for the answer` +
        ` (so about ${fmt(Math.max(budget - systemTokens, 0))} for the message itself). ` +
        'Shorten it, or split the file and ask about one part at a time.',
    )
  }

  let used = fixed
  let keepFrom = opts.history.length
  for (let i = opts.history.length - 1; i >= 0; i--) {
    if (used + historyTokens[i] > budget) break
    used += historyTokens[i]
    keepFrom = i
  }
  // A kept history must not open on an answer whose question was dropped.
  while (keepFrom < opts.history.length && opts.history[keepFrom].role === 'assistant') {
    used -= historyTokens[keepFrom]
    keepFrom++
  }

  return {
    messages: [
      { role: 'system', content: opts.system },
      ...opts.history.slice(keepFrom),
      { role: 'user', content: opts.current },
    ],
    dropped: keepFrom,
    promptTokens: used,
    // `used` stays within the budget, so the whole reserve is always free.
    maxTokens: reserve,
  }
}

const fmt = (n: number) => n.toLocaleString('en-US')

// ── Streaming ───────────────────────────────────────────────────────────────

/**
 * How far the server is through reading the prompt, from llama-server's
 * `prompt_progress` (asked for with `return_progress`). `cached` tokens were
 * reused from the previous request and cost nothing; `processed` counts them.
 */
export interface PromptProgress {
  total: number
  cached: number
  processed: number
  ms: number
}

/**
 * POST and stream the response, over node:http rather than fetch.
 *
 * fetch (undici) gives up on a response that sends nothing for five minutes,
 * and a home server reading a 100k-token chat export can stay silent longer
 * than that when it doesn't report progress. Here there is no idle timeout:
 * the turn ends when the server answers, errors, or the person presses Stop.
 */
function postStream(
  cfg: LocalConfig,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  const url = new URL(`${cfg.baseUrl}${path}`)
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'POST',
        headers: { ...headers(cfg, true), 'Content-Length': payload.length, Accept: 'text/event-stream' },
        signal,
      },
      resolve,
    )
    req.on('error', (err: any) => {
      if (err?.name === 'AbortError') return reject(err)
      const code = err?.code
      reject(new Error(
        code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH'
          ? `The local model server at ${cfg.baseUrl} isn't reachable (${code}).`
          : `Couldn't reach the local model server at ${cfg.baseUrl}: ${err?.message ?? err}`,
      ))
    })
    req.end(payload)
  })
}

async function readAll(res: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  for await (const p of res) parts.push(p as Buffer)
  return Buffer.concat(parts).toString('utf8')
}

export interface StreamResult {
  text: string
  finishReason: string | null
  /** Prompt + completion as the server counted them, when it says. */
  usage: { prompt: number; completion: number } | null
  toolCalls: ToolCall[]
}

/**
 * One chat completion, streamed. `onDelta` gets answer text as it arrives.
 * Tool-call deltas are assembled too (index-keyed, arguments concatenated, as
 * the OpenAI stream sends them), so the loop in runTurn can act on them once
 * tools are offered; with no `tools` in the request a server sends none.
 */
export async function streamChat(
  cfg: LocalConfig,
  req: {
    model: string
    messages: ChatMessage[]
    maxTokens: number
    signal?: AbortSignal
    onDelta?: (text: string) => void
    /** Prompt reading, as the server reports it (llama-server only). */
    onProgress?: (p: PromptProgress) => void
    tools?: unknown[]
  },
): Promise<StreamResult> {
  const res = await postStream(cfg, '/v1/chat/completions', {
    model: serverModelId(req.model),
    messages: req.messages,
    max_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    // llama-server streams `prompt_progress` while it reads the prompt — the
    // part that takes minutes on a long input. Other servers ignore it.
    return_progress: true,
    ...(req.tools?.length ? { tools: req.tools } : {}),
  }, req.signal)
  const status = res.statusCode ?? 0
  if (status < 200 || status >= 300) {
    const message = await describeFailure(cfg, new Response(await readAll(res), { status }))
    if (/context|too long|exceed/i.test(message)) {
      throw new ContextOverflowError(`The local model couldn't fit this conversation in its context window: ${message}`)
    }
    throw new Error(message)
  }

  let text = ''
  let finishReason: string | null = null
  let usage: StreamResult['usage'] = null
  const calls: ToolCall[] = []

  const handle = (data: string) => {
    if (data === '[DONE]') return
    let chunk: any
    try {
      chunk = JSON.parse(data)
    } catch {
      return
    }
    if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? 'The local model failed mid-answer.')
    if (chunk.usage) {
      usage = { prompt: Number(chunk.usage.prompt_tokens) || 0, completion: Number(chunk.usage.completion_tokens) || 0 }
    }
    const pp = chunk.prompt_progress
    if (pp && Number(pp.total) > 0) {
      req.onProgress?.({
        total: Number(pp.total),
        cached: Number(pp.cache) || 0,
        processed: Number(pp.processed) || 0,
        ms: Number(pp.time_ms) || 0,
      })
    }
    const choice = chunk.choices?.[0]
    if (!choice) return
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content
      req.onDelta?.(delta.content)
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = Number(tc.index ?? calls.length)
      calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (tc.id) calls[i].id = tc.id
      if (tc.function?.name) calls[i].function.name += tc.function.name
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  const decoder = new TextDecoder()
  let buf = ''
  for await (const part of res) {
    buf += decoder.decode(part as Buffer, { stream: true })
    // Server-sent events: blank-line separated, `data:` lines carry the JSON.
    let cut: number
    while ((cut = buf.search(/\r?\n\r?\n/)) !== -1) {
      const event = buf.slice(0, cut)
      buf = buf.slice(cut).replace(/^\r?\n\r?\n/, '')
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith('data:')) handle(line.slice(5).trim())
      }
    }
  }
  for (const line of buf.split(/\r?\n/)) if (line.startsWith('data:')) handle(line.slice(5).trim())

  return { text, finishReason, usage, toolCalls: calls.filter(Boolean) }
}

/**
 * A turn: one completion today. This is the extension point for tools.
 *
 * A v2 offers a small curated set (read an uploaded file, query PocketBase,
 * fetch a URL) as `tools`, and loops: when the answer comes back with
 * `toolCalls`, run each one HERE, in the backend — nothing about a local turn
 * may go through the engine — append the assistant message carrying the calls
 * and one `{role: 'tool', tool_call_id, content}` per result, re-fit the
 * budget, and stream again until an answer has no calls. The stream already
 * assembles calls; what is missing is the toolset and its executor.
 */
export async function runTurn(
  cfg: LocalConfig,
  req: Parameters<typeof streamChat>[1],
): Promise<StreamResult> {
  return streamChat(cfg, req)
}

/** A short completion, not streamed — for titles. */
export async function completeOnce(
  cfg: LocalConfig,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  timeoutMs = 120_000,
): Promise<string> {
  const res = await localFetch(cfg, '/v1/chat/completions', {
    method: 'POST',
    headers: headers(cfg, true),
    body: JSON.stringify({ model: serverModelId(model), messages, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(await describeFailure(cfg, res))
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return body.choices?.[0]?.message?.content ?? ''
}

// ── Attachments ─────────────────────────────────────────────────────────────

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.htm', '.yaml', '.yml', '.ini', '.srt', '.vtt', '.eml', '.ics', '.vcf'])

/**
 * Raw bytes read per file before any token check. Far above any window a home
 * server runs (a 32k window holds ~100 KB of text) so the budget, not this,
 * is what refuses a big file — this only stops a 100 MB upload being read
 * into memory to be told it is too big.
 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024

export interface InlineFile {
  originalName: string
  mimetype: string
  path: string
}

/**
 * A file as message text. The local model has no tools to open files with, so
 * what it is to read goes inline: text files as they are, a zip's text entries
 * (a WhatsApp export arrives as one on iOS, `_chat.txt` inside), and anything
 * else as a line saying it is there and can't be read — better than the model
 * pretending to have seen a photo.
 */
export function inlineAttachment(file: InlineFile): string {
  const label = `${file.originalName} (${file.mimetype})`
  if (!existsSync(file.path)) return `[Attached file ${label}: no longer on disk]`
  const size = statSync(file.path).size
  const ext = extname(file.originalName || file.path).toLowerCase()

  if (ext === '.zip' || file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed') {
    if (size > 64 * 1024 * 1024) return `[Attached archive ${label}: too large to open]`
    try {
      const entries = textEntriesOfZip(readFileSync(file.path), { exts: TEXT_EXT, maxBytes: MAX_TEXT_BYTES })
      if (!entries.length) return `[Attached archive ${label}: it holds no text files the local model can read]`
      return entries
        .map((e) => fence(`${file.originalName} › ${e.name}`, e.text))
        .join('\n\n')
    } catch (err: any) {
      return `[Attached archive ${label}: couldn't be opened (${err?.message ?? err})]`
    }
  }

  const textual = file.mimetype.startsWith('text/') || TEXT_EXT.has(ext) || /json|csv|xml/.test(file.mimetype)
  if (!textual) return `[Attached file ${label}: the local model can only read text, so it can't see this file]`
  if (size > MAX_TEXT_BYTES) {
    return `[Attached file ${label}: ${Math.round(size / 1024)} KB, far beyond what the local model can read at once]`
  }
  return fence(file.originalName, readFileSync(file.path, 'utf8'))
}

function fence(name: string, text: string): string {
  return `<file name="${name.replace(/"/g, "'")}">\n${text.replace(/^﻿/, '').trimEnd()}\n</file>`
}
