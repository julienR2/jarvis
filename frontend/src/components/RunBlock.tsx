import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ChevronRight, Clock, Link2, Loader2, MessageCircleQuestion, Settings2, Square } from 'lucide-react'
import type { Message, Run } from '../api'
import MessageBubble from './MessageBubble'

/**
 * A cron or webhook's contribution to the transcript, as ordinary messages.
 *
 * A run is not content — the message it produced is. So the run gets one thin
 * line of provenance (what fired, and its state only while that state is
 * news — the time is the message's own, underneath) and its messages render exactly like any other assistant turn: the
 * answer in full, the steps folded to one line underneath. The routine's own
 * prompt is machinery and stays behind a click.
 *
 * `run` can be missing — the runs list is capped, so an old enough block
 * outlives its row. The block still renders from the messages alone.
 */
export default function RunBlock({
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
  const [showPrompt, setShowPrompt] = useState(false)
  const prompt = msgs.find((m) => m.role === 'user')
  const output = msgs.filter((m) => m !== prompt)
  const running = run?.status === 'running' || (live && !run)
  const Icon = run?.kind === 'webhook' ? Link2 : Clock

  return (
    <div className='my-3 animate-fade-in' data-testid='run-card'>
      <div className='mb-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-muted'>
        <span className='inline-flex items-center gap-1 rounded-full bg-surface2 px-2 py-px font-medium text-text-secondary'>
          <Icon size={10} />
          {run?.source_name ?? 'automation'}
        </span>
        <State run={run} running={running} />
        {prompt && (
          <button
            type='button'
            onClick={() => setShowPrompt((v) => !v)}
            className='inline-flex items-center gap-0.5 transition-colors hover:text-text-primary'
          >
            <ChevronRight size={9} className={`transition-transform ${showPrompt ? 'rotate-90' : ''}`} />
            prompt
          </button>
        )}
        {run?.source_id && (
          <button
            type='button'
            onClick={() => navigate(`/routines?edit=${run.source_id}`)}
            title='Open this routine'
            className='rounded p-0.5 transition-colors hover:text-text-primary'
          >
            <Settings2 size={11} />
          </button>
        )}
      </div>

      {showPrompt && prompt && (
        <div className='mb-3 whitespace-pre-wrap rounded-lg border border-border bg-bg-alt px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary'>
          {prompt.content}
        </div>
      )}

      {output.map((m) => (
        <MessageBubble key={m.id} msg={m} live={live && m.id === lastMessageId} />
      ))}

      {output.length === 0 && !running && !run?.error && (
        <div className='mb-3 text-[13px] text-text-muted'>No output.</div>
      )}
      {run?.error && (
        <div className='mb-3 flex items-start gap-1.5 text-[13px] text-danger'>
          <AlertCircle size={13} className='mt-0.5 shrink-0' />
          <span className='break-words'>{run.error}</span>
        </div>
      )}
    </div>
  )
}

/** Only states that are news get a word; done is the default and says nothing. */
function State({ run, running }: { run?: Run; running: boolean }) {
  if (running || run?.status === 'running') {
    return <span className='inline-flex items-center gap-1 text-accent'><Loader2 size={10} className='animate-spin' /> running</span>
  }
  switch (run?.status) {
    case 'needs_you':
      return <span className='inline-flex items-center gap-1 text-warning'><MessageCircleQuestion size={10} /> waiting for you</span>
    case 'error':
      return <span className='inline-flex items-center gap-1 text-danger'><AlertCircle size={10} /> failed</span>
    case 'stopped':
      return <span className='inline-flex items-center gap-1'><Square size={8} fill='currentColor' /> stopped</span>
    case 'interrupted':
      return <span>interrupted</span>
    default:
      return null
  }
}
