import { SAMPLE_RATE, transcribe } from './model.ts'

const BYTES_PER_SECOND = SAMPLE_RATE * 2
const WINDOW = Math.round(0.3 * SAMPLE_RATE) // samples
const STEP = Math.round(0.03 * SAMPLE_RATE)

/**
 * Where to cut audio that has grown long enough: the middle of its quietest
 * 300 ms after `minSeconds` — between two words, as a rule, so none is split
 * in half. Returns a byte offset.
 */
function cutPoint(pcm16: Buffer, minSeconds: number): number {
  const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.byteLength / 2))
  const start = Math.round(minSeconds * SAMPLE_RATE)
  const end = samples.length - Math.round(0.5 * SAMPLE_RATE)
  let best = Math.min(samples.length, start)
  let bestEnergy = Infinity
  for (let s = start; s + WINDOW <= end; s += STEP) {
    let energy = 0
    for (let i = s; i < s + WINDOW; i += 4) energy += samples[i] * samples[i]
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = s + WINDOW / 2
    }
  }
  return Math.round(best) * 2
}

/**
 * Audio arriving a little at a time, transcribed in pieces as it comes: once
 * `segmentSeconds` have built up, everything up to a pause is sent to the model
 * and the rest waits for more. At the end only the last piece is left to do,
 * however long the whole was.
 */
export class Segmenter {
  private pending = Buffer.alloc(0)
  private readonly parts: Promise<string>[] = []
  private readonly segmentBytes: number
  private readonly minSeconds: number

  constructor(segmentSeconds = 12, minSeconds = 5) {
    this.segmentBytes = segmentSeconds * BYTES_PER_SECOND
    this.minSeconds = minSeconds
  }

  push(pcm16: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm16]) : Buffer.from(pcm16)
    while (this.pending.length >= this.segmentBytes) {
      const cut = cutPoint(this.pending, this.minSeconds)
      this.queue(this.pending.subarray(0, cut))
      this.pending = Buffer.from(this.pending.subarray(cut))
    }
  }

  /** The whole transcript, once the last piece is done. */
  async finish(): Promise<string> {
    if (this.pending.length) this.queue(this.pending)
    this.pending = Buffer.alloc(0)
    const texts = await Promise.all(this.parts)
    return texts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  }

  private queue(pcm16: Buffer) {
    const part = transcribe(pcm16)
    // Awaited in finish(); this only keeps a failure there from also being
    // reported as unhandled before then.
    part.catch(() => {})
    this.parts.push(part)
  }
}

/** A whole recording at once: the same pieces, longer, since nobody waits on the last. */
export function transcribeAll(pcm16: Buffer): Promise<string> {
  const segmenter = new Segmenter(25, 10)
  segmenter.push(pcm16)
  return segmenter.finish()
}
