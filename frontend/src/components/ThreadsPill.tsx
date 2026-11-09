import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Hash, Plus, Repeat, RotateCcw } from 'lucide-react'
import type { Conversation, Message, Run } from '../api'
import { relative } from '../lib/runs'
import { isActiveThread } from '../lib/threads'
import Popover from './Popover'

interface Props {
  /** The chat's sub-chats: threads opened from its passages, or blank from here. */
  threads: Conversation[]
  /** The threads of the routines reporting into this chat. */
  routines: Conversation[]
  /** The chat's recent runs — a routine's row says how its last one went. */
  runs: Run[]
  /** The chat's loaded messages, for the passage each thread came from. */
  messages: Message[]
  activeId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onArchive: (thread: Conversation, archived: boolean) => void
}

/**
 * A chat's threads, in its title bar: the way back to a thread without
 * scrolling to the message it came from. Active ones first, most recent
 * first; put away (Done) or a week untouched, they fold under Archived. The
 * routines reporting into the chat are listed too — a routine is a thread of
 * the whole chat rather than of one message — with how their last run went.
 */
export default function ThreadsPill({ threads, routines, runs, messages, activeId, onOpen, onNew, onArchive }: Props) {
  const [open, setOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (!open) setShowArchived(false) }, [open])

  const byRecent = (a: Conversation, b: Conversation) => b.updated_at - a.updated_at
  const active = threads.filter((t) => isActiveThread(t)).sort(byRecent)
  const archived = threads.filter((t) => !isActiveThread(t)).sort(byRecent)
  const unread = active.reduce((n, t) => n + (t.id === activeId ? 0 : t.unread_count), 0)

  const pick = (id: string) => {
    setOpen(false)
    onOpen(id)
  }

  return (
    <div className='relative flex shrink-0 items-center'>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        data-testid='threads-pill'
        aria-label={`Threads${active.length ? ` (${active.length})` : ''}${unread ? `, ${unread} new` : ''}`}
        title='Threads of this chat'
        className={`relative flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${open ? 'border-accent/40 bg-accent-subtle text-accent' : 'border-border text-text-muted hover:border-accent/40 hover:text-text-primary'}`}
      >
        <Hash size={11} />
        {active.length > 0 && <span>{active.length}</span>}
        {unread > 0 && <span className='absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent' data-testid='threads-pill-unread' />}
      </button>

      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} className='w-80 max-w-[calc(100vw-16px)] rounded-xl border border-border bg-surface p-1 shadow-md/5'>
        <div onClick={(e) => e.stopPropagation()} data-testid='threads-popover'>
          {active.length === 0 && (
            <p className='px-2.5 py-2 text-[12px] text-text-muted'>
              No thread open here. Start one below, or select a passage of the chat and press #.
            </p>
          )}
          {active.map((t) => (
            <ThreadRow key={t.id} thread={t} messages={messages} selected={t.id === activeId} onOpen={() => pick(t.id)}
              action={{ label: `Done with ${t.title}`, icon: <Check size={12} />, run: () => onArchive(t, true) }} />
          ))}

          <div className='mt-1 flex items-center gap-1 border-t border-border px-1 pt-1'>
            <button onClick={() => { setOpen(false); onNew() }} className='flex flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-text-secondary hover:bg-surface2 hover:text-text-primary'>
              <Plus size={12} /> New thread
            </button>
            {archived.length > 0 && (
              <button onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived} className='flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-text-muted hover:bg-surface2 hover:text-text-primary'>
                Archived ({archived.length}) <ChevronRight size={12} className={`transition-transform ${showArchived ? 'rotate-90' : ''}`} />
              </button>
            )}
          </div>
          {showArchived && archived.map((t) => (
            <ThreadRow key={t.id} thread={t} messages={messages} selected={t.id === activeId} muted onOpen={() => pick(t.id)}
              action={{ label: `Reopen ${t.title}`, icon: <RotateCcw size={12} />, run: () => onArchive(t, false) }} />
          ))}

          {routines.length > 0 && (
            <>
              <div className='mt-1 border-t border-border px-2.5 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted'>Routines</div>
              {routines.map((r) => (
                <button key={r.id} onClick={() => pick(r.id)} className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface2 ${r.id === activeId ? 'bg-surface2' : ''}`}>
                  <Repeat size={12} className='mt-0.5 shrink-0 text-text-muted' />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[12.5px] text-text-primary'>{r.title}</span>
                    <span className='block truncate text-[11px] text-text-muted'>{lastRun(runs, r.title)}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </Popover>
    </div>
  )
}

function ThreadRow({ thread, messages, selected, muted, onOpen, action }: {
  thread: Conversation
  messages: Message[]
  selected: boolean
  muted?: boolean
  onOpen: () => void
  action: { label: string; icon: React.ReactNode; run: () => void }
}) {
  const fresh = !selected && thread.unread_count > 0
  const source = messages.find((m) => m.id === thread.parent_message_id)
  const passage = source ? (source.role === 'assistant' ? source.result ?? source.content : source.content).replace(/\s+/g, ' ').trim() : ''
  return (
    <div className={`group flex items-start gap-1 rounded-lg ${selected ? 'bg-surface2' : 'hover:bg-surface2'}`} data-testid='thread-row'>
      <button onClick={onOpen} className={`flex min-w-0 flex-1 items-start gap-2 px-2.5 py-1.5 text-left ${muted ? 'opacity-70' : ''}`}>
        <Hash size={12} className='mt-0.5 shrink-0 text-accent' />
        <span className='min-w-0 flex-1'>
          <span className='flex items-baseline gap-2'>
            <span className={`truncate text-[12.5px] ${fresh ? 'font-semibold text-text-primary' : 'text-text-primary'}`}>{thread.title}</span>
            <span className='ml-auto shrink-0 text-[10.5px] text-text-muted'>
              {fresh ? <span className='rounded-full bg-accent px-1.5 font-medium text-white'>{thread.unread_count} new</span> : relative(thread.updated_at)}
            </span>
          </span>
          {passage && <span className='mt-0.5 block truncate text-[11px] italic text-text-muted'>❝ {passage}</span>}
        </span>
      </button>
      <button onClick={action.run} title={action.label} aria-label={action.label} className='mr-1 mt-1 rounded-md p-1 text-text-muted opacity-0 hover:bg-border hover:text-text-primary group-hover:opacity-100 [@media(hover:none)]:opacity-100'>
        {action.icon}
      </button>
    </div>
  )
}

/** "7:00 PM · nothing to report" — how the routine's last run in this chat went. */
function lastRun(runs: Run[], name: string): string {
  const last = runs.filter((r) => r.source_name === name).sort((a, b) => b.started_at - a.started_at)[0]
  if (!last) return 'no run here yet'
  const when = relative(last.ended_at ?? last.started_at)
  const how = last.status === 'running' ? 'running'
    : last.status === 'needs_you' ? 'waiting for you'
    : last.status === 'error' ? 'failed'
    : last.status === 'stopped' || last.status === 'interrupted' ? 'stopped'
    : last.quiet ? 'nothing to report' : 'reported'
  return `${when} · ${how}`
}
