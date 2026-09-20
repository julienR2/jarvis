import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ChevronRight, Clock, Link2, Loader2, MessageCircleQuestion, Settings2, Square } from 'lucide-react'
import type { Message, Run } from '../api'
import MessageBubble from './MessageBubble'
import { firstLine, formatTime } from '../lib/runs'

/**
 * A cron or webhook's contribution to the transcript, as ordinary messages.
 *
 * A run is not content — the message it produced is. So the run gets one thin
 * line of provenance (what fired, when, and its state only while that state is
 * news) and its messages render exactly like any other assistant turn: the
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
  const startedAt = run?.started_at ?? msgs[0]?.created_at

  return (
    <div className='my-3 animate-fade-in' data-testid='run-card'>
      <div className='group mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-muted'>
        <span className='inline-flex items-center gap-1 rounded-full bg-surface2 px-2 py-px font-medium text-text-secondary'>
          <Icon size={10} />
          {run?.source_name ?? 'automation'}
        </span>
        {startedAt && <span>{formatTime(startedAt)}</span>}
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
            className='rounded p-0.5 opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100 focus:opacity-100'
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

/**
 * A stretch of runs that had nothing to report, folded into one grey line.
 *
 * Fifteen "skipped" triages a day used to be fifteen cards. Here they are one
 * sentence — how many, which routines, over what span — that opens into the
 * list, and from there into any one run's messages for whoever wants them.
 */
export function QuietRuns({ blocks }: { blocks: { run: Run; msgs: Message[] }[] }) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const names = [...new Set(blocks.map((b) => b.run.source_name))]
  const first = blocks[0].run.started_at
  const last = blocks[blocks.length - 1].run.started_at
  const span = first === last ? formatTime(first) : `${formatTime(first)} – ${formatTime(last)}`
  const n = blocks.length

  return (
    <div className='my-3' data-testid='quiet-runs'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2 text-[11.5px] text-text-muted transition-colors hover:text-text-secondary'
        aria-expanded={open}
      >
        <span className='shrink-0'>
          {names.join(', ')} · {n} {n === 1 ? 'run' : 'runs'}, nothing to report
        </span>
        <span className='h-px flex-1 border-t border-dashed border-border' />
        <span className='shrink-0'>{span}</span>
        <ChevronRight size={10} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className='mt-1.5 ml-2 border-l border-border pl-3'>
          {blocks.map(({ run, msgs }) => (
            <div key={run.id}>
              <button
                type='button'
                onClick={() => setShown((s) => (s === run.id ? null : run.id))}
                className='flex w-full items-baseline gap-2 py-1 text-left text-[12px] text-text-muted transition-colors hover:text-text-primary'
              >
                <span className='shrink-0 tabular-nums'>{formatTime(run.started_at)}</span>
                <span className='min-w-0 flex-1 truncate'>{run.result ? quietLine(run.result) : run.source_name}</span>
              </button>
              {shown === run.id && (
                <div className='pb-1 pl-11'>
                  <RunBlock run={run} msgs={msgs} live={false} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One line for a quiet run. A triage answers with a table, whose first line is
 * the header — the row is what says which mail was skipped.
 */
function quietLine(result: string): string {
  const lines = result.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines[0]?.startsWith('|')) {
    const body = lines.slice(1).find((l) => l.startsWith('|') && !/^\|[\s:|-]+\|$/.test(l))
    if (body) {
      return body.split('|').map((c) => c.trim()).filter(Boolean).join(' · ')
    }
  }
  return firstLine(result)
}
