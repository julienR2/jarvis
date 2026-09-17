import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Check, ChevronRight, Clock, Link2, Loader2, MessageCircleQuestion, Settings2, Square } from 'lucide-react'
import type { Message, Run } from '../api'
import MessageBubble, { Markdown } from './MessageBubble'

/**
 * A cron or webhook's contribution to the transcript, as one card.
 *
 * A background run used to land as its raw messages behind a thin divider:
 * the automation's prompt, an activity bubble of steps, a result, sometimes an
 * error — forty lines of machinery for one event, interleaved with the
 * conversation proper. The card inverts that: the header says what ran and how
 * it went, the body is the one paragraph it produced, and the messages
 * themselves sit behind "details" for whoever needs them.
 *
 * `run` can be missing — the runs list is capped, so an old enough block
 * outlives its row. The card still renders from the messages alone.
 */
export default function RunCard({
  run,
  msgs,
  live,
  lastMessageId,
}: {
  run?: Run
  msgs: Message[]
  /** A turn is being written into this block right now. */
  live: boolean
  lastMessageId?: string
}) {
  const navigate = useNavigate()
  const running = run?.status === 'running' || run?.status === 'needs_you' || (live && !run)
  // A run in progress is worth watching; once done the summary is the point
  // and the rest is a click away.
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? running

  const name = run?.source_name
  const kindLabel = run?.kind === 'webhook' ? 'Webhook' : run?.kind === 'cron' ? 'Cron' : 'Automation'
  const summary = summaryOf(msgs)

  return (
    <div
      className='my-4 overflow-hidden rounded-xl border border-border bg-surface animate-fade-in'
      data-testid='run-card'
    >
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-bg-alt px-3 py-2 text-[12px]'>
        {run?.kind === 'webhook' ? (
          <Link2 size={12} className='shrink-0 text-text-muted' />
        ) : (
          <Clock size={12} className='shrink-0 text-text-muted' />
        )}
        <span className='min-w-0 truncate font-medium text-text-primary'>
          {name ? `${kindLabel}: ${name}` : kindLabel}
        </span>
        {run && (
          <span className='text-text-muted'>· {formatWhen(run.started_at)}</span>
        )}
        <span className='flex-1' />
        <StatusPill run={run} live={live} />
        {run?.source_id && (
          // Straight to this routine's definition, open for editing in Activity.
          <button
            type='button'
            onClick={() => navigate(`/activity?tab=routines&edit=${run.source_id}`)}
            title={`Open this ${run.kind}'s settings`}
            className='rounded p-0.5 text-text-muted/60 transition-colors hover:bg-surface2 hover:text-text-primary'
          >
            <Settings2 size={13} />
          </button>
        )}
      </div>

      <div className='px-3 py-2.5'>
        {summary ? (
          <Markdown text={summary} className='text-[15px] leading-relaxed' />
        ) : run?.status === 'needs_you' ? (
          <div className='flex items-center gap-2 text-[13px] text-text-secondary'>
            <MessageCircleQuestion size={12} className='text-warning' /> Waiting for your answer below.
          </div>
        ) : running ? (
          <div className='flex items-center gap-2 text-[13px] text-text-secondary'>
            <Loader2 size={12} className='animate-spin text-accent' /> Working…
          </div>
        ) : (
          <div className='text-[13px] text-text-muted'>No output.</div>
        )}
        {run?.error && (
          <div className='mt-2 flex items-start gap-1.5 text-[13px] text-danger'>
            <AlertCircle size={13} className='mt-0.5 shrink-0' />
            <span className='break-words'>{run.error}</span>
          </div>
        )}

        <button
          type='button'
          onClick={() => setOpen(!expanded)}
          className='mt-2 flex items-center gap-1 text-[11px] text-text-muted/70 transition-colors hover:text-text-muted'
        >
          <ChevronRight size={10} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
          {expanded ? 'hide details' : `details · ${msgs.length} message${msgs.length !== 1 ? 's' : ''}`}
        </button>

        {expanded && (
          <div className='mt-3 border-l-2 border-border pl-3'>
            {msgs.map((m) => (
              <MessageBubble key={m.id} msg={m} live={live && m.id === lastMessageId} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * What the run has to say for itself: the last assistant message's prose —
 * its `result` when it was an activity message, its content otherwise.
 */
function summaryOf(msgs: Message[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant' || m.type === 'error') continue
    if (m.result) return m.result
    if (m.content && !/^\[(tool|chunk|note)(?::\d+)?\] /.test(m.content)) return m.content
  }
  return null
}

function StatusPill({ run, live }: { run?: Run; live: boolean }) {
  const base = 'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium'
  if (!run) {
    return live ? (
      <span className={`${base} border-accent/30 text-accent`}><Loader2 size={10} className='animate-spin' /> running</span>
    ) : null
  }
  switch (run.status) {
    case 'running':
      return <span className={`${base} border-accent/30 text-accent`}><Loader2 size={10} className='animate-spin' /> running · {formatDuration(run.started_at, null)}</span>
    case 'needs_you':
      return <span className={`${base} border-warning/40 text-warning`}><MessageCircleQuestion size={10} /> waiting for you</span>
    case 'done':
      return <span className={`${base} border-success/40 text-success`}><Check size={10} /> done · {formatDuration(run.started_at, run.ended_at)}</span>
    case 'error':
      return <span className={`${base} border-danger/40 text-danger`}><AlertCircle size={10} /> failed</span>
    case 'stopped':
      return <span className={`${base} border-border text-text-muted`}><Square size={9} fill='currentColor' /> stopped</span>
    case 'interrupted':
      return <span className={`${base} border-border text-text-muted`}>interrupted</span>
  }
}

function formatDuration(start: number, end: number | null): string {
  const secs = Math.max(0, Math.floor(((end ?? Date.now() / 1000) - start)))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function formatWhen(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
