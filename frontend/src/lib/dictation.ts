import { ApiError, api, isMissing, type Missing } from '../api'

/**
 * A voice recording that streams to the speech service while it is spoken.
 *
 * The microphone is read as 16 kHz mono PCM and sent about a second at a time,
 * so by the time the person stops, the server has heard — and transcribed —
 * all but the last few seconds. The whole recording stays here in memory: the
 * server says how many bytes it holds, and anything it lacks is sent again from
 * there, whether a request failed, the connection dropped for a minute, or the
 * service restarted and lost it all. Only when that keeps failing past
 * GIVE_UP_MS is the recording uploaded whole instead (see api.ts), which also
 * reaches ElevenLabs if the local service is down.
 */

const RATE = 16000
const BYTES_PER_SECOND = RATE * 2
/** Sent once this much is waiting; on stop, whatever is left. */
const SEND_EVERY = BYTES_PER_SECOND
/** Catching up after an outage goes in pieces of at most this. */
const MAX_REQUEST = 512 * 1024
const GIVE_UP_MS = 2 * 60_000

/** A failure retrying won't fix: no speech, signed out, a bad request. */
function isFinal(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500
}

/** The server answered, with an error: the speech service is down, not the
 *  network. Worth a couple more tries, not minutes of them. */
const isServerError = (err: unknown) => err instanceof ApiError && err.status >= 500

export class Recording {
  readonly id = crypto.randomUUID()
  private pcm = new Uint8Array(BYTES_PER_SECOND * 30)
  private length = 0
  /** How much the server says it holds. */
  private received = 0
  private pumping = false
  private ended = false
  private discarded = false
  private failures = 0
  /** Set when the server refused the audio for good. */
  private fatal: unknown = null
  private settled: { resolve(): void; reject(err: unknown): void }[] = []

  get bytes(): number {
    return this.length
  }

  append(samples: Int16Array) {
    if (this.ended) return
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
    if (this.length + bytes.length > this.pcm.length) {
      const grown = new Uint8Array(Math.max(this.pcm.length * 2, this.length + bytes.length))
      grown.set(this.pcm.subarray(0, this.length))
      this.pcm = grown
    }
    this.pcm.set(bytes, this.length)
    this.length += bytes.length
    if (this.length - this.received >= SEND_EVERY) void this.pump()
  }

  /** No more audio: what is still here goes now. */
  end() {
    this.ended = true
    void this.pump()
  }

  discard() {
    this.ended = this.discarded = true
    void api.dropDictation(this.id).catch(() => {})
  }

  /** The recording as a WAV file, for the upload fallback. */
  wav(): Blob {
    const header = new DataView(new ArrayBuffer(44))
    const text = (at: number, s: string) => [...s].forEach((c, i) => header.setUint8(at + i, c.charCodeAt(0)))
    text(0, 'RIFF')
    header.setUint32(4, 36 + this.length, true)
    text(8, 'WAVE')
    text(12, 'fmt ')
    header.setUint32(16, 16, true)
    header.setUint16(20, 1, true) // PCM
    header.setUint16(22, 1, true) // mono
    header.setUint32(24, RATE, true)
    header.setUint32(28, BYTES_PER_SECOND, true)
    header.setUint16(32, 2, true)
    header.setUint16(34, 16, true)
    text(36, 'data')
    header.setUint32(40, this.length, true)
    return new Blob([header, this.pcm.slice(0, this.length)], { type: 'audio/wav' })
  }

  /**
   * Runs `ask` — finishing the dictation — once the server holds every byte,
   * and again after sending what it says it lacks. Network trouble is waited
   * out; it throws only when retrying cannot help or GIVE_UP_MS have gone by.
   */
  async deliver<T>(ask: (id: string, length: number) => Promise<T | Missing>): Promise<T> {
    this.end()
    const deadline = Date.now() + GIVE_UP_MS
    for (let attempt = 0; ; attempt++) {
      await this.sent(deadline)
      try {
        const answer = await ask(this.id, this.length)
        if (!isMissing(answer)) return answer
        this.received = Math.min(answer.missing, this.length)
        void this.pump()
      } catch (err) {
        if (isFinal(err) || (isServerError(err) && attempt >= 2) || Date.now() > deadline) throw err
        await pause(backoff(attempt))
      }
    }
  }

  /** Resolves once the server holds all of it; throws past the deadline. */
  private sent(deadline: number): Promise<void> {
    if (this.fatal) return Promise.reject(this.fatal)
    if (this.received >= this.length) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The recording couldn't reach the server")), Math.max(0, deadline - Date.now()))
      this.settled.push({
        resolve() {
          clearTimeout(timer)
          resolve()
        },
        reject(err) {
          clearTimeout(timer)
          reject(err)
        },
      })
      void this.pump()
    })
  }

  private settle(err?: unknown) {
    const waiting = this.settled
    this.settled = []
    waiting.forEach((w) => (err ? w.reject(err) : w.resolve()))
  }

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.discarded && this.received < this.length && (this.ended || this.length - this.received >= SEND_EVERY)) {
        const from = this.received
        const to = Math.min(this.length, from + MAX_REQUEST)
        try {
          const { received } = await api.appendDictation(this.id, from, this.pcm.slice(from, to))
          this.received = Math.min(received, this.length)
          this.failures = 0
        } catch (err) {
          if (isFinal(err) || (isServerError(err) && this.ended && this.failures >= 2)) {
            this.fatal = err
            this.settle(err)
            return
          }
          await pause(backoff(this.failures++))
        }
      }
      if (this.received >= this.length) this.settle()
    } finally {
      this.pumping = false
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** attempt)
}

/** Waits `ms`, or less if the connection comes back meanwhile. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      window.removeEventListener('online', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    window.addEventListener('online', done)
  })
}

// Runs on the audio thread: hands the microphone's samples over in batches,
// rather than 128 at a time.
const TAP = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0 }
    }
    return true
  }
}
registerProcessor('jarvis-tap', Tap)
`

/** Averages the device's rate down to 16 kHz and into PCM16, chunk after chunk. */
function downsampler(inputRate: number) {
  const ratio = inputRate / RATE
  let acc = 0
  let n = 0
  let t = 0
  return (input: Float32Array): Int16Array => {
    const out = new Int16Array(Math.ceil(input.length / ratio) + 1)
    let o = 0
    for (let i = 0; i < input.length; i++) {
      acc += input[i]
      n++
      if (++t >= ratio) {
        const v = Math.max(-1, Math.min(1, acc / n))
        out[o++] = v < 0 ? v * 0x8000 : v * 0x7fff
        acc = n = 0
        t -= ratio
      }
    }
    return out.subarray(0, o)
  }
}

export interface Microphone {
  recording: Recording
  /** Stops listening; the recording keeps sending what it has left. */
  stop(): void
}

/**
 * Opens the microphone and starts a recording. Call it straight from the tap:
 * iOS only lets audio start inside the gesture, so the AudioContext is made
 * before anything is awaited.
 */
export async function listen(): Promise<Microphone> {
  const ctx = new AudioContext()
  let stream: MediaStream | null = null
  try {
    void ctx.resume()
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = ctx.createMediaStreamSource(stream)
    // No outputs: a node without any is processed without being wired to the speakers.
    const tap = new AudioWorkletNode(ctx, 'jarvis-tap', { numberOfOutputs: 0 })
    const recording = new Recording()
    const toPcm = downsampler(ctx.sampleRate)
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => recording.append(toPcm(e.data))
    source.connect(tap)
    const tracks = stream.getTracks()
    return {
      recording,
      stop() {
        tap.port.onmessage = null
        source.disconnect()
        tap.disconnect()
        tracks.forEach((t) => t.stop())
        void ctx.close()
      },
    }
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop())
    void ctx.close()
    throw err
  }
}
