import { config } from './config.js'

/**
 * The local speech-to-text service (stt/): Parakeet, on this machine's CPU.
 * A dictation streams into it while the person speaks, a recording already
 * made is sent whole.
 */

/** Dictation ids are made by the client — a uuid, checked before it goes in a URL. */
export const DICTATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Transcribes a whole file in any format ffmpeg reads. */
export async function transcribeFile(audio: Blob, filename = 'audio'): Promise<string> {
  const form = new FormData()
  form.append('audio_file', audio, filename)
  const res = await fetch(`${config.sttUrl}/asr?output=txt`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Transcription failed: ${res.status}`)
  return (await res.text()).trim()
}

/** A dictation answer the client acts on: where to resume from, or the words. */
export type DictationAnswer =
  | { status: 200; body: { received: number } | { transcript: string } }
  | { status: 409; body: { received: number } }

async function dictation(path: string, init: RequestInit): Promise<DictationAnswer> {
  const res = await fetch(`${config.sttUrl}/dictation/${path}`, init)
  if (res.status !== 200 && res.status !== 409) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error || `Speech service answered ${res.status}`)
  }
  return { status: res.status, body: await res.json() } as DictationAnswer
}

/** Audio from byte `offset` on; answers with how much the service now holds. */
export function appendDictation(id: string, offset: number, pcm16: Buffer) {
  return dictation(`${id}?offset=${offset}`, { method: 'PUT', body: new Uint8Array(pcm16) })
}

/** The transcript, once the service holds all `length` bytes — a 409 says what it lacks. */
export function finishDictation(id: string, length: number) {
  return dictation(`${id}/finish?length=${length}`, { method: 'POST' })
}

export function dropDictation(id: string) {
  return dictation(id, { method: 'DELETE' }).catch(() => {})
}
