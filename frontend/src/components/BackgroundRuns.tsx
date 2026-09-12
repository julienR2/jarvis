import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Link2, Loader2, Square } from 'lucide-react'
import { api, type Run } from '../api'
import { useChatStore } from '../stores/chatStore'

/**
 * The cron/webhook runs happening in this conversation right now, and a way to
 * stop them.
 *
 * Lives at the conversation level rather than on each message because a run is
 * not a message: several can be in flight at once (two fires of the same
 * webhook, a cron landing while another still works), they interleave their
 * output, and only one of them may be the one worth stopping. A per-message
 * control could not express that; a list can.
 */
export default function BackgroundRuns({ conversationId }: { conversationId?: string }) {
  const runs = useChatStore((s) =>
    conversationId ? s.activeRuns[conversationId] : undefined,
  )
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState<Record<string, boolean>>({})
  const containerRef = useRef<HTMLDivElement>(null)

  const handleOutside = useCallback((e: Event) => {
    if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
  }, [])

  useEffect(() => {
    if (!open) return
    window.addEventListener('click', handleOutside)
    window.addEventListener('touchstart', handleOutside)
    return () => {
      window.removeEventListener('click', handleOutside)
      window.removeEventListener('touchstart', handleOutside)
    }
  }, [open, handleOutside])

  // The list emptying while the panel is open would leave an empty box hanging
  // under the header — the last run finishing is itself the signal to close.
  useEffect(() => {
    if (runs && runs.length === 0) setOpen(false)
  }, [runs])

  if (!runs || runs.length === 0) return null

  async function stop(run: Run) {
    setStopping((s) => ({ ...s, [run.id]: true }))
    try {
      await api.stopRun(run.id)
    } catch (err) {
      console.error('Failed to stop run:', err)
      setStopping((s) => ({ ...s, [run.id]: false }))
    }
    // On success the stream pushes the new run list, which unmounts this row.
  }

  return (
    <div ref={containerRef} className='relative flex items-center shrink-0'>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded-full border border-accent/30 px-2 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent-subtle ${open ? 'bg-accent-subtle' : ''}`}
        title={`${runs.length} background run${runs.length > 1 ? 's' : ''} — click to stop`}
      >
        <Loader2 size={11} className='animate-spin' />
        {runs.length > 1 ? `${runs.length} runs` : '1 run'}
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className='absolute right-0 top-full mt-1 z-[200] w-72 rounded-xl border border-border bg-surface p-1 shadow-md/5'
        >
          {runs.map((run) => (
            <div key={run.id} className='flex items-center gap-2 rounded-lg px-2 py-1.5'>
              {run.kind === 'cron' ? (
                <Clock size={13} className='shrink-0 text-text-muted' />
              ) : (
                <Link2 size={13} className='shrink-0 text-text-muted' />
              )}
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-xs text-text-primary'>
                  {run.source_name}
                </span>
                <span className='block text-[10px] text-text-muted'>
                  {formatElapsed(run.started_at)}
                  {/* Worth saying here and not only on the transcript marker:
                      it explains why stopping this changes nothing about the
                      conversation's own session. */}
                  {!run.inherit_context && ' · no chat context'}
                </span>
              </span>
              <button
                onClick={() => stop(run)}
                disabled={stopping[run.id]}
                className='flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface2 hover:text-red-500 disabled:opacity-40'
                title='Stop this run'
              >
                {stopping[run.id] ? (
                  <Loader2 size={11} className='animate-spin' />
                ) : (
                  <Square size={11} fill='currentColor' />
                )}
                Stop
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Coarse on purpose — a run's age is context, not a stopwatch. */
function formatElapsed(startedAt: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - startedAt)
  if (secs < 60) return 'just started'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `running ${mins} min`
  const hours = Math.floor(mins / 60)
  return `running ${hours}h ${mins % 60}m`
}
