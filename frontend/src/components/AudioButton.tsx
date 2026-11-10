import { useState, useRef, useEffect } from 'react'
import { Mic, Send, X, PenLine } from 'lucide-react'
import { listen, type Microphone, type Recording } from '../lib/dictation'

interface Props {
  onAudioReady: (recording: Recording) => Promise<void>
  onTranscribeReady?: (recording: Recording) => Promise<void>
  onActiveChange?: (active: boolean) => void
  disabled?: boolean
  /** Something is typed already: the recording can only become more text in
   *  the box, not be sent as it is. */
  textOnly?: boolean
}

type State = 'idle' | 'recording'

/**
 * Records, then hands the recording over and is ready again at once: the
 * transcription that follows belongs to the chat it was recorded for, and the
 * composer shows it from the draft (lib/drafts) — still there after leaving
 * the chat and coming back, which state in here could not be.
 *
 * The audio streams to the server while it is spoken (lib/dictation), so by
 * the time the recording is handed over most of it is already transcribed.
 */

export default function AudioButton({ onAudioReady, onTranscribeReady, onActiveChange, disabled, textOnly }: Props) {
  const [state, setState] = useState<State>('idle')
  const [duration, setDuration] = useState(0)
  const stateRef = useRef<State>('idle')
  const startingRef = useRef(false)
  const micRef = useRef<Microphone | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const mountedRef = useRef(true)

  function updateState(s: State) {
    stateRef.current = s
    setState(s)
  }

  useEffect(() => {
    onActiveChange?.(state !== 'idle')
  }, [state, onActiveChange])

  const onAudioRef = useRef(onAudioReady)
  onAudioRef.current = onAudioReady
  const onTranscribeRef = useRef(onTranscribeReady)
  onTranscribeRef.current = onTranscribeReady
  // Unmounted mid-recording — another chat opened: the words are kept, as
  // text in the draft of the chat they were spoken for, not sent and not lost.
  useEffect(() => () => {
    mountedRef.current = false
    if (stateRef.current === 'recording' && onTranscribeRef.current) {
      finish('transcribe')
    } else {
      micRef.current?.recording.discard()
      halt()
    }
  }, [])

  async function start() {
    if (stateRef.current !== 'idle' || startingRef.current || disabled) return
    startingRef.current = true
    try {
      const mic = await listen()
      if (!mountedRef.current) {
        mic.stop()
        mic.recording.discard()
        return
      }
      micRef.current = mic
      navigator.wakeLock?.request('screen').then((lock) => { wakeLockRef.current = lock }).catch(() => {})
      updateState('recording')
      startTimeRef.current = Date.now()
      setDuration(0)
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }, 1000)
    } catch (err) {
      console.error('Recording failed:', err)
      halt()
    } finally {
      startingRef.current = false
    }
  }

  /** Stops the microphone and the timer, and forgets the recording. */
  function halt() {
    wakeLockRef.current?.release().catch(() => {})
    wakeLockRef.current = null
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    micRef.current?.stop()
    micRef.current = null
    updateState('idle')
    setDuration(0)
  }

  function finish(mode: 'send' | 'transcribe') {
    if (stateRef.current !== 'recording' || !micRef.current) return
    const { recording } = micRef.current
    halt()
    if (recording.bytes === 0) return
    recording.end()
    const handOver = mode === 'transcribe' && onTranscribeRef.current ? onTranscribeRef.current : onAudioRef.current
    handOver(recording).catch((err) => console.error('Audio processing failed:', err))
  }

  function stop() {
    finish('send')
  }

  function stopTranscribeOnly() {
    finish('transcribe')
  }

  function cancel() {
    if (stateRef.current !== 'recording') return
    micRef.current?.recording.discard()
    halt()
  }

  function fmt(s: number) {
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  }

  if (state === 'recording') {
    return (
      <div className="flex items-center gap-1 h-8">
        <button
          onClick={cancel}
          className="p-2 rounded-xl text-text-muted hover:text-danger hover:bg-bg transition-colors"
          title="Cancel recording"
        >
          <X size={16} />
        </button>
        <span className="flex items-center gap-1.5 text-danger text-xs font-medium px-1">
          <span className="w-2 h-2 rounded-full bg-danger animate-pulse" />
          {fmt(duration)}
        </span>
        {onTranscribeReady && textOnly ? (
          <button
            onClick={stopTranscribeOnly}
            className="p-2 rounded-xl bg-accent text-white hover:opacity-90 transition-opacity"
            title="Transcribe to text"
          >
            <PenLine size={16} />
          </button>
        ) : (
          <>
            {onTranscribeReady && (
              <button
                onClick={stopTranscribeOnly}
                className="p-1.5 rounded-xl text-text-muted hover:text-text-primary hover:bg-bg transition-colors"
                title="Transcribe to text"
              >
                <PenLine size={14} />
              </button>
            )}
            <button
              onClick={stop}
              className="p-2 rounded-xl bg-accent text-white hover:opacity-90 transition-opacity"
              title="Send voice message"
            >
              <Send size={16} />
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={start}
      disabled={disabled}
      title="Tap to record"
      className="p-2 rounded-xl transition-colors text-text-muted hover:text-text-primary hover:bg-surface2 disabled:opacity-30"
    >
      <Mic size={16} />
    </button>
  )
}
