import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ChevronRight, Hash, MessageCircleQuestion, Repeat } from 'lucide-react'
import type { Message } from '../api'
import type { RunReport as Report } from '../lib/transcript'
import MessageBubble from './MessageBubble'

/** Where a run lives: its thread, scrolled to it. */
export function runPath(report: { thread_id: string; run_id: string }): string {
  return `/c/${report.thread_id}?run=${report.run_id}`
}

const time = (at: number) => new Date(at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * A routine's run, as the chat it reports into sees it: one line of where it
 * came from, then what it had to say. The work itself stays in the thread,
 * one click away.
 */
export function RunReportCard({ msg, report, onMarkUnread }: {
  msg: Message
  report: Report
  onMarkUnread?: (messageId: string) => void
}) {
  const navigate = useNavigate()
  const failed = report.status === 'error' || report.status === 'interrupted'
  // A report is stored as a bare result (no steps of its own): drawn as prose.
  const shown = useMemo(() => ({ ...msg, content: msg.result ?? '' }), [msg])
  return (
    <div className='my-3 animate-fade-in' data-testid='run-report'>
      <div className='mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-muted'>
        <span className='inline-flex items-center gap-1 rounded-full bg-surface2 px-2 py-px font-medium text-text-secondary'>
          <Repeat size={10} />
          {report.source_name}
        </span>
        {report.status === 'needs_you' && (
          <span className='inline-flex items-center gap-1 text-accent'>
            <MessageCircleQuestion size={10} /> asked you
          </span>
        )}
        {failed && (
          <span className='inline-flex items-center gap-1 text-danger'>
            <AlertCircle size={10} /> {report.status === 'error' ? 'failed' : 'interrupted'}
          </span>
        )}
        <button
          type='button'
          onClick={() => navigate(runPath(report))}
          title='Open the thread at this run'
          className='inline-flex items-center gap-1 transition-colors hover:text-text-primary'
        >
          <Hash size={10} /> thread
        </button>
      </div>
      {failed ? (
        <div className='mb-3 flex items-start gap-1.5 text-[13px] text-danger'>
          <AlertCircle size={13} className='mt-0.5 shrink-0' />
          <span className='break-words'>{msg.result}</span>
        </div>
      ) : (
        <MessageBubble msg={shown} live={false} onMarkUnread={onMarkUnread} />
      )}
    </div>
  )
}

/**
 * Runs that had nothing to say, stacked: one quiet line however many there
 * were in a row. It opens to the list — each one a way into its thread.
 */
export function RunReportStack({ entries }: { entries: { msg: Message; report: Report }[] }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const names = [...new Set(entries.map((e) => e.report.source_name))]
  const last = entries[entries.length - 1]
  const label = entries.length === 1
    ? `${names[0]} ran · nothing to report`
    : `${names.length === 1 ? names[0] : `${names.length} routines`} ran ${entries.length}× · nothing to report`
  return (
    <div className='my-2' data-testid='run-report-stack'>
      <button
        type='button'
        onClick={() => (entries.length === 1 ? navigate(runPath(last.report)) : setOpen((v) => !v))}
        className='inline-flex items-center gap-1.5 text-[11px] text-text-muted transition-colors hover:text-text-secondary'
      >
        {entries.length > 1 && <ChevronRight size={10} className={`transition-transform ${open ? 'rotate-90' : ''}`} />}
        {entries.length === 1 && <Repeat size={10} />}
        <span>{label}</span>
        <span className='text-text-muted/70'>· {entries.length > 1 ? 'last ' : ''}{time(last.msg.created_at)}</span>
      </button>
      {open && (
        <div className='mt-1 ml-3 flex flex-col border-l border-border pl-3'>
          {entries.map(({ msg, report }) => (
            <button
              key={msg.id}
              type='button'
              onClick={() => navigate(runPath(report))}
              className='flex min-w-0 items-baseline gap-2 py-0.5 text-left text-[11px] text-text-muted transition-colors hover:text-text-primary'
            >
              <span className='shrink-0 tabular-nums'>{time(msg.created_at)}</span>
              {names.length > 1 && <span className='shrink-0 text-text-secondary'>{report.source_name}</span>}
              <span className='truncate'>{(msg.result ?? '').split('\n')[0]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
