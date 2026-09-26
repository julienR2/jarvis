import { create } from 'zustand'
import { api, type Attachment, type Effort } from '../api'
import { useChatStore } from '../stores/chatStore'

/**
 * A chat started from Today opens the moment Send is pressed — before the
 * voice message is transcribed or the attachments finish uploading. What is
 * still on its way waits here, keyed by the new conversation, and the chat
 * draws it: "Transcribing…" in the composer for a voice message, the message
 * itself with its uploads spinning for text and files. The entry goes once
 * the real message is in the chat (or the send failed).
 */
export interface OutgoingFile {
  name: string
  /** Object URL of an image, revoked once the send settles. */
  preview?: string
  uploading: boolean
}

export type Outgoing =
  | { kind: 'voice' }
  | { kind: 'message'; text: string; files: OutgoingFile[] }

export const useOutbox = create<Record<string, Outgoing>>(() => ({}))

function put(id: string, entry: Outgoing | null) {
  useOutbox.setState((s) => {
    const next = { ...s }
    if (entry) next[id] = entry
    else delete next[id]
    return next
  }, true)
}

/** A file picked in the composer, its upload possibly still running. */
export interface OutgoingUpload {
  file: File
  preview?: string
  uploaded?: Attachment
  upload: Promise<Attachment>
}

type What =
  | { kind: 'voice'; audio: Blob }
  | { kind: 'message'; text: string; files: OutgoingUpload[] }

/**
 * Creates the chat and hands back its id as soon as it exists — the caller
 * opens it — then finishes sending in the background.
 */
export async function startChat(what: What, model: string, effort: Effort): Promise<string> {
  const conv = await useChatStore.getState().createConversation()
  const id = conv.id
  if (what.kind === 'voice') {
    put(id, { kind: 'voice' })
  } else {
    put(id, {
      kind: 'message',
      text: what.text,
      files: what.files.map((f) => ({ name: f.file.name, preview: f.preview, uploading: !f.uploaded })),
    })
  }
  void deliver(id, what, model, effort)
  return id
}

async function deliver(id: string, what: What, model: string, effort: Effort) {
  try {
    if (what.kind === 'voice') {
      // A failed transcription is reported inside the chat by the server.
      const { message } = await api.sendAudio(id, what.audio, model, effort).catch(() => ({ message: null }))
      if (message) useChatStore.getState().upsertMessage(id, message)
    } else {
      const attachments: Attachment[] = []
      await Promise.all(
        what.files.map(async (f, i) => {
          const att = await f.upload.catch(() => null)
          if (att) attachments[i] = att
          const entry = useOutbox.getState()[id]
          if (entry?.kind === 'message') {
            put(id, { ...entry, files: entry.files.map((x, j) => (j === i ? { ...x, uploading: false } : x)) })
          }
        }),
      )
      const sent = attachments.filter(Boolean)
      if (!what.text.trim() && sent.length === 0) throw new Error('nothing uploaded')
      if (sent.length < what.files.length) window.__jarvisToast?.error("A file couldn't be uploaded — sent without it.")
      const { message } = await api.sendMessage(id, what.text, sent, model, effort)
      useChatStore.getState().upsertMessage(id, message)
    }
    useChatStore.getState().rememberModel(id, model, effort)
  } catch (err) {
    console.error('Could not send the first message:', err)
    window.__jarvisToast?.error("Couldn't send the message — try again.")
  } finally {
    put(id, null)
    if (what.kind === 'message') for (const f of what.files) if (f.preview) URL.revokeObjectURL(f.preview)
  }
}
