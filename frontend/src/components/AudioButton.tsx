import { useState, useRef, useEffect } from 'react'
import { Mic, Send, Loader2 } from 'lucide-react'

interface Props {
  onAudioReady: (blob: Blob) => Promise<void>
  onActiveChange?: (active: boolean) => void
  disabled?: boolean
}

type State = 'idle' | 'recording' | 'processing'

export default function AudioButton({ onAudioReady, onActiveChange, disabled }: Props) {
  const [state, setState] = useState<State>('idle')
  const [duration, setDuration] = useState(0)
  const stateRef = useRef<State>('idle')
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)

  function updateState(s: State) {
    stateRef.current = s
    setState(s)
  }

  useEffect(() => {
    onActiveChange?.(state !== 'idle')
  }, [state, onActiveChange])

  useEffect(() => () => cleanup(), [])

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

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        chunksRef.current = []

        if (blob.size > 0) {
          updateState('processing')
          try {
            await onAudioReady(blob)
          } catch (err) {
            console.error('Audio processing failed:', err)
          } finally {
            updateState('idle')
          }
        } else {
          updateState('idle')
        }
      }

      recorder.start(250)
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

  function stop() {
    if (stateRef.current !== 'recording') return
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (mediaRef.current && mediaRef.current.state !== 'inactive') {
      mediaRef.current.stop()
    }
    mediaRef.current = null
  }

  function cleanup() {
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

  if (state === 'processing') {
    return (
      <div className="flex items-center gap-2 text-text-muted h-8">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-xs">Transcribing…</span>
      </div>
    )
  }

  if (state === 'recording') {
    return (
      <div className="flex items-center gap-2 h-8">
        <span className="flex items-center gap-1.5 text-danger text-xs font-medium">
          <span className="w-2 h-2 rounded-full bg-danger animate-pulse" />
          {fmt(duration)}
        </span>
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
