/**
 * Generating media, when the conversation's model makes pictures rather than text.
 *
 * These models are not agents and there is no CLI involved: the message is the
 * prompt, and the answer is a file. So a message to one bypasses the engine
 * entirely and calls the gateway's media endpoint directly.
 *
 * This is what makes "a pixel art picture of an island at sunset" produce an
 * island rather than a paragraph about one. Choosing an image model chooses the
 * pipeline, not just the engine.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { gatewayConfig } from './catalogue.js'
import type { ModelKind } from './catalogue.js'
import { UPLOADS_DIR } from './routes/uploads.js'

export interface GeneratedMedia {
  url: string
  path: string
  mimetype: string
  originalName: string
  size: number
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
}

function save(
  conversationId: string,
  data: Buffer,
  mimetype: string,
  label: string,
): GeneratedMedia {
  // Per-conversation, like uploads: the file is served only to people who can
  // already see this conversation.
  const dir = join(UPLOADS_DIR, conversationId)
  mkdirSync(dir, { recursive: true })
  const name = `${randomUUID()}.${EXT[mimetype] ?? 'bin'}`
  writeFileSync(join(dir, name), data)
  return {
    url: `/api/uploads/files/${conversationId}/${name}`,
    path: join(dir, name),
    mimetype,
    originalName: label,
    size: data.length,
  }
}

/** POST /v1/images — synchronous, returns base64 in data[0].b64_json. */
async function generateImage(
  conversationId: string,
  model: string,
  prompt: string,
): Promise<GeneratedMedia> {
  const cfg = gatewayConfig()
  if (!cfg) throw new Error('No gateway configured')

  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v1/images`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, prompt, n: 1, output_format: 'png' }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(describeFailure(res.status, detail))
  }

  const body = (await res.json()) as {
    data?: { b64_json?: string; media_type?: string }[]
  }
  const first = body.data?.[0]
  if (!first?.b64_json) throw new Error('The model returned no image.')
  return save(
    conversationId,
    Buffer.from(first.b64_json, 'base64'),
    first.media_type ?? 'image/png',
    prompt.slice(0, 60),
  )
}

/**
 * POST /v1/videos then poll — video is a job, not a response.
 *
 * Minutes, not seconds, so the caller streams progress rather than blocking a
 * request on it.
 */
async function generateVideo(
  conversationId: string,
  model: string,
  prompt: string,
  onProgress?: (note: string) => void,
): Promise<GeneratedMedia> {
  const cfg = gatewayConfig()
  if (!cfg) throw new Error('No gateway configured')
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const auth = { Authorization: `Bearer ${cfg.authToken}` }

  const submit = await fetch(`${base}/v1/videos`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!submit.ok) {
    throw new Error(describeFailure(submit.status, await submit.text().catch(() => '')))
  }
  const job = (await submit.json()) as { id?: string; status?: string }
  if (!job.id) throw new Error('The gateway accepted the request but returned no job id.')

  // 10s between polls, up to 15 minutes — generous, since a long clip is slow,
  // and the alternative is telling the user it failed when it hadn't.
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 10_000))
    const poll = await fetch(`${base}/v1/videos/${job.id}`, { headers: auth })
    if (!poll.ok) continue
    const state = (await poll.json()) as {
      status?: string
      unsigned_urls?: string[]
      error?: string
    }
    if (state.status === 'completed') {
      const url = state.unsigned_urls?.[0]
      if (!url) throw new Error('The job completed but returned no video.')
      const file = await fetch(url, { signal: AbortSignal.timeout(180_000) })
      const buf = Buffer.from(await file.arrayBuffer())
      return save(conversationId, buf, 'video/mp4', prompt.slice(0, 60))
    }
    if (['failed', 'cancelled', 'expired'].includes(state.status ?? '')) {
      throw new Error(`The video job ${state.status}${state.error ? `: ${state.error}` : ''}.`)
    }
    if (i === 2) onProgress?.('Still rendering — video takes a few minutes.')
  }
  throw new Error('The video job is still running after 15 minutes; giving up on it.')
}

/** Errors worth reading. A 402 is not a transient failure to retry. */
function describeFailure(status: number, detail: string): string {
  const trimmed = detail.slice(0, 300)
  if (status === 402) return 'The OpenRouter account is out of credit.'
  if (status === 401) return 'The OpenRouter key was rejected.'
  if (status === 429) return 'Rate limited by the gateway — try again shortly.'
  return `The gateway returned ${status}${trimmed ? `: ${trimmed}` : ''}`
}

export async function generateMedia(opts: {
  kind: ModelKind
  conversationId: string
  model: string
  prompt: string
  onProgress?: (note: string) => void
}): Promise<GeneratedMedia> {
  if (opts.kind === 'image') {
    return generateImage(opts.conversationId, opts.model, opts.prompt)
  }
  if (opts.kind === 'video') {
    return generateVideo(opts.conversationId, opts.model, opts.prompt, opts.onProgress)
  }
  throw new Error(`${opts.kind} generation isn't supported yet.`)
}
