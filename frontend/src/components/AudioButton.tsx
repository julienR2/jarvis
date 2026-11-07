import { useState, useRef, useEffect } from 'react'
import { Mic, Send, X, Type } from 'lucide-react'

interface Props {
  onAudioReady: (blob: Blob) => Promise<void>
  onTranscribeReady?: (blob: Blob) => Promise<void>
  onActiveChange?: (active: boolean) => void
  disabled?: boolean
}

type State = 'idle' | 'recording'

/**
 * Records, then hands the audio over and is ready again at once: the
 * transcription that follows belongs to the chat it was recorded for, and the
 * composer shows it from the draft (lib/drafts) — still there after leaving
 * the chat and coming back, which state in here could not be.
 */

export default function AudioButton({ onAudioReady, onTranscribeReady, onActiveChange, disabled }: Props) {
  const [state, setState] = useState<State>('idle')
  const [duration, setDuration] = useState(0)
  const stateRef = useRef<State>('idle')
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)
  const cancelledRef = useRef(false)
  const modeRef = useRef<'send' | 'transcribe'>('send')
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)

  function updateState(s: State) {
    stateRef.current = s
    setState(s)
  }

  useEffect(() => {
    onActiveChange?.(state !== 'idle')
  }, [state, onActiveChange])

  const onTranscribeRef = useRef(onTranscribeReady)
  onTranscribeRef.current = onTranscribeReady
  // Unmounted mid-recording — another chat opened: the words are kept, as
  // text in the draft of the chat they were spoken for, not sent and not lost.
  useEffect(() => () => {
    if (stateRef.current === 'recording' && onTranscribeRef.current) {
      modeRef.current = 'transcribe'
      doStop()
    } else {
      cleanup()
    }
  }, [])

  async function start() {
    if (stateRef.current !== 'idle' || disabled) return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      mediaRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        recorder.stream.getTracks().forEach((t) => t.stop())

        if (cancelledRef.current) {
          cancelledRef.current = false
          chunksRef.current = []
          updateState('idle')
          return
        }

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        chunksRef.current = []
        const mode = modeRef.current
        modeRef.current = 'send'
        updateState('idle')
        if (blob.size === 0) return
        try {
          if (mode === 'transcribe' && onTranscribeReady) {
            await onTranscribeReady(blob)
          } else {
            await onAudioReady(blob)
          }
        } catch (err) {
          console.error('Audio processing failed:', err)
        }
      }

      recorder.start(250)
      navigator.wakeLock?.request('screen').then((lock) => { wakeLockRef.current = lock }).catch(() => {})
      updateState('recording')
      startTimeRef.current = Date.now()
      setDuration(0)
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }, 1000)
    } catch (err) {
      console.error('Recording failed:', err)
      cleanup()
    }
  }

  function releaseWakeLock() {
    wakeLockRef.current?.release().catch(() => {})
    wakeLockRef.current = null
  }

  function doStop() {
    if (stateRef.current !== 'recording') return
    releaseWakeLock()
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (mediaRef.current && mediaRef.current.state !== 'inactive') {
      mediaRef.current.stop()
    }
    mediaRef.current = null
  }

  function stop() {
    modeRef.current = 'send'
    doStop()
  }

  function stopTranscribeOnly() {
    modeRef.current = 'transcribe'
    doStop()
  }

  function cancel() {
    if (stateRef.current !== 'recording') return
    cancelledRef.current = true
    releaseWakeLock()
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (mediaRef.current && mediaRef.current.state !== 'inactive') {
      mediaRef.current.stop()
    }
    mediaRef.current = null
    setDuration(0)
  }

  function cleanup() {
    releaseWakeLock()
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (mediaRef.current) {
      mediaRef.current.stream.getTracks().forEach((t) => t.stop())
      if (mediaRef.current.state !== 'inactive') {
        try { mediaRef.current.stop() } catch { /* already stopped */ }
      }
      mediaRef.current = null
    }
    chunksRef.current = []
    updateState('idle')
    setDuration(0)
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
        {onTranscribeReady && (
          <button
            onClick={stopTranscribeOnly}
            className="p-1.5 rounded-xl text-text-muted hover:text-text-primary hover:bg-bg transition-colors"
            title="Transcribe to text"
          >
            <Type size={14} />
          </button>
        )}
        <button
          onClick={stop}
          className="p-2 rounded-xl bg-accent text-white hover:opacity-90 transition-opacity"
          title="Send voice message"
        >
          <Send size={16} />
        </button>
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
