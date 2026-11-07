import { create } from 'zustand'
import { api, withMediaToken, type Attachment } from '../api'

/**
 * What is typed, attached and being transcribed in a composer, kept per chat.
 *
 * The composer used to hold its own state and was never remounted between
 * chats, so a half-written message followed you into the next chat, and a
 * transcription that finished after you left landed in whichever chat was on
 * screen. Each chat now has its draft here: switching shows the other chat's
 * (blank if it has none), coming back shows yours as you left it, and work
 * still running — an upload, a transcription — finishes into the chat it was
 * started in.
 *
 * Text and finished uploads survive a reload (localStorage); a file still
 * uploading, or one that failed, does not. Keys starting with `tmp:` are for
 * composers that have no chat yet to belong to, and are never saved.
 */
export interface DraftFile {
  /** Stable identity: the list is edited while uploads finish in any order. */
  key: string
  name: string
  type: string
  /** An image's object URL — or, restored after a reload, its upload URL. */
  preview?: string
  uploaded?: Attachment
  error?: string
  /** Resolves to `uploaded`; a restored file's is already settled. */
  upload: Promise<Attachment>
}

export interface Draft {
  text: string
  files: DraftFile[]
  /** Voice messages of this chat being transcribed or sent, still on the way. */
  transcribing: number
}

const EMPTY: Draft = { text: '', files: [], transcribing: 0 }
const STORAGE_KEY = 'composer-drafts'

type Saved = Record<string, { text: string; attachments: Attachment[] }>

function load(): Record<string, Draft> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Saved
    const drafts: Record<string, Draft> = {}
    for (const [key, d] of Object.entries(saved)) {
      drafts[key] = {
        text: d.text || '',
        files: (d.attachments || []).map(restored),
        transcribing: 0,
      }
    }
    return drafts
  } catch {
    return {}
  }
}

function restored(att: Attachment): DraftFile {
  return {
    key: att.id,
    name: att.originalName,
    type: att.mimetype,
    preview: att.mimetype.startsWith('image/') ? withMediaToken(att.url) : undefined,
    uploaded: att,
    upload: Promise.resolve(att),
  }
}

function save(drafts: Record<string, Draft>) {
  const out: Saved = {}
  for (const [key, d] of Object.entries(drafts)) {
    if (key.startsWith('tmp:')) continue
    const attachments = d.files.flatMap((f) => (f.uploaded ? [f.uploaded] : []))
    if (d.text || attachments.length) out[key] = { text: d.text, attachments }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
  } catch {
    /* private window, or storage full — the draft lives until the tab closes */
  }
}

export const useDrafts = create<Record<string, Draft>>(load)
useDrafts.subscribe(save)

function update(key: string, fn: (d: Draft) => Partial<Draft>) {
  useDrafts.setState((s) => {
    const d = s[key] ?? EMPTY
    const next = { ...d, ...fn(d) }
    const rest = { ...s }
    if (!next.text && next.files.length === 0 && next.transcribing === 0) delete rest[key]
    else rest[key] = next
    return rest
  }, true)
}

export function useDraft(key: string): Draft {
  return useDrafts((s) => s[key] ?? EMPTY)
}

/** Something to come back to: words or a file. Drives the sidebar's pencil. */
export function hasDraft(d: Draft | undefined): boolean {
  return !!d && (!!d.text.trim() || d.files.length > 0)
}

export const drafts = {
  get: (key: string): Draft => useDrafts.getState()[key] ?? EMPTY,

  setText: (key: string, text: string) => update(key, () => ({ text })),

  /** Dictated words join what is already typed, never replace it. */
  appendText: (key: string, words: string) =>
    update(key, (d) => ({ text: d.text + (d.text && !/\s$/.test(d.text) ? ' ' : '') + words })),

  /** Starts each upload; it lands in this chat's draft whenever it ends. */
  addFiles: (key: string, files: File[], conversationId?: string) => {
    const added = files.map((file): DraftFile => {
      const k = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const upload = api.uploadFile(file, conversationId)
      const patch = (p: Partial<DraftFile>) =>
        update(key, (d) => ({ files: d.files.map((f) => (f.key === k ? { ...f, ...p } : f)) }))
      upload.then(
        (uploaded) => patch({ uploaded }),
        (err: Error) => patch({ error: err.message }),
      )
      return {
        key: k,
        name: file.name,
        type: file.type,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        upload,
      }
    })
    update(key, (d) => ({ files: [...d.files, ...added] }))
  },

  removeFile: (key: string, fileKey: string) =>
    update(key, (d) => {
      const f = d.files.find((x) => x.key === fileKey)
      if (f) revoke([f])
      return { files: d.files.filter((x) => x.key !== fileKey) }
    }),

  /** Empties the draft for a send, handing back what it held. Previews stay
   *  alive: the sender revokes them once it no longer draws them. */
  take: (key: string): { text: string; files: DraftFile[] } => {
    const { text, files } = drafts.get(key)
    update(key, () => ({ text: '', files: [] }))
    return { text, files }
  },

  /** A send that failed: what it took goes back, ahead of anything typed since. */
  restore: (key: string, taken: { text: string; files: DraftFile[] }) =>
    update(key, (d) => ({
      text: [taken.text, d.text].filter((t) => t.trim()).join(' '),
      files: [...taken.files, ...d.files],
    })),

  /** Around a voice message's transcription, so the chat it belongs to shows
   *  "Transcribing…" even after you leave it and come back. */
  track: async <T>(key: string, work: Promise<T>): Promise<T> => {
    update(key, (d) => ({ transcribing: d.transcribing + 1 }))
    try {
      return await work
    } finally {
      update(key, (d) => ({ transcribing: Math.max(0, d.transcribing - 1) }))
    }
  },
}

export function revoke(files: Pick<DraftFile, 'preview'>[]) {
  for (const f of files) if (f.preview?.startsWith('blob:')) URL.revokeObjectURL(f.preview)
}

/** The attachments of what finished uploading, waiting for those still going.
 *  A file that failed is left out. */
export async function settleUploads(files: Pick<DraftFile, 'upload'>[]): Promise<Attachment[]> {
  const done = await Promise.all(files.map((f) => f.upload.catch(() => null)))
  return done.filter((a): a is Attachment => !!a)
}

/** A voice message's words, after whatever was typed with it. */
export function spoken(typed: string, transcript: string): string {
  return [typed.trim(), transcript.trim()].filter(Boolean).join('\n\n')
}
