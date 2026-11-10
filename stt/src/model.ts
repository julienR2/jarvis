import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * NVIDIA Parakeet TDT 0.6B v3, int8, run by sherpa-onnx on the CPU — the model
 * Paseo dictates with. It reads 25 European languages (French and English
 * among them) and tells them apart itself, and on a CPU it is several times
 * faster than Whisper small while making fewer mistakes.
 */
const MODEL_NAME = process.env.STT_MODEL || 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`
const MODEL_DIR = process.env.MODEL_DIR || '/models'
const THREADS = Number(process.env.STT_THREADS) || 4

export const SAMPLE_RATE = 16000

interface Stream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
}
interface Recognizer {
  createStream(): Stream
  decodeAsync(stream: Stream): Promise<{ text?: string }>
}

let recognizer: Recognizer | null = null

export function ready(): boolean {
  return recognizer !== null
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))))
  })
}

/** Fetches the model into the volume the first time, then loads it. */
export async function loadModel(): Promise<void> {
  const dir = path.join(MODEL_DIR, MODEL_NAME)
  if (!existsSync(path.join(dir, 'tokens.txt'))) {
    // Unpacked beside the target and moved in whole, so an interrupted
    // download is never mistaken for a model.
    const partial = path.join(MODEL_DIR, '.partial')
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    console.log(`[stt] downloading ${MODEL_URL}`)
    await run('sh', ['-c', `curl -fsSL "$0" | tar xj -C "$1"`, MODEL_URL, partial])
    renameSync(path.join(partial, MODEL_NAME), dir)
    rmSync(partial, { recursive: true, force: true })
  }

  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as {
    OfflineRecognizer: { createAsync(config: unknown): Promise<Recognizer> }
  }
  const file = (name: string) => path.join(dir, name)
  recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: file('encoder.int8.onnx'),
        decoder: file('decoder.int8.onnx'),
        joiner: file('joiner.int8.onnx'),
      },
      modelType: 'nemo_transducer',
      tokens: file('tokens.txt'),
      numThreads: THREADS,
      provider: 'cpu',
    },
    decodingMethod: 'greedy_search',
  })
  console.log(`[stt] ${MODEL_NAME} loaded, ${THREADS} threads`)
}

// One decode at a time: each already uses every thread it was given, and two
// dictations at once should share the CPU in turn rather than thrash it.
let queue: Promise<unknown> = Promise.resolve()

/**
 * Transcribes 16 kHz mono PCM16. Quiet speech is raised towards a fixed peak
 * first, as Paseo does — a phone held at arm's length still reads — and audio
 * with nothing above the noise floor is not decoded at all.
 */
export function transcribe(pcm16: Buffer): Promise<string> {
  const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.byteLength / 2))
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i])
    if (v > peak) peak = v
  }
  if (peak < 300) return Promise.resolve('')
  const gain = Math.min(50, Math.max(1, (0.6 * 32768) / peak))
  const floats = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) floats[i] = (samples[i] / 32768) * gain

  const job = queue.then(async () => {
    if (!recognizer) throw new Error('Model not loaded yet')
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples: floats, sampleRate: SAMPLE_RATE })
    const result = await recognizer.decodeAsync(stream)
    return (result.text ?? '').trim()
  })
  queue = job.catch(() => {})
  return job
}
