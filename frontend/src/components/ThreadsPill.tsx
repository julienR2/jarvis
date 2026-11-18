import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronRight, Clock, Hash, Link2, RotateCcw } from 'lucide-react'
import type { Conversation, Message } from '../api'
import { relative } from '../lib/runs'
import { CreateRow, SubChatRow } from './SubChatRow'
import { isActiveThread, routineKindOf } from '../lib/threads'
import Popover from './Popover'

interface Props {
  /** The conversations under this chat: side chats and routines alike. */
  threads: Conversation[]
  /** The chat's loaded messages, for the passage a thread was opened on. */
  messages: Message[]
  activeId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onArchive: (thread: Conversation, archived: boolean) => void
}

/**
 * A chat's threads, in its title bar: the way back to them without scrolling
 * to where they started. One list, most recent first — a side chat, or a
 * routine's conversation (its mark says which: a schedule, a webhook); put
 * away with Done, they fold under Archived. Ends with the way to start one.
 */
export default function ThreadsPill({ threads, messages, activeId, onOpen, onNew, onArchive }: Props) {
  const [open, setOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()

  const byRecent = (a: Conversation, b: Conversation) => b.updated_at - a.updated_at
  const active = threads.filter((t) => isActiveThread(t)).sort(byRecent)
  const archived = threads.filter((t) => !isActiveThread(t)).sort(byRecent)
  const unread = active.reduce((n, t) => n + (t.id === activeId ? 0 : t.unread_count), 0)

  const close = () => { setOpen(false); setShowArchived(false) }
  const pick = (id: string) => {
    close()
    onOpen(id)
  }
  const row = (t: Conversation, archivedRow: boolean) => {
    const fresh = t.id !== activeId && t.unread_count > 0
    const waiting = t.id !== activeId && !!t.pending_question
    const kind = routineKindOf(t)
    return (
      <SubChatRow
        key={t.id}
        testId='thread-row'
        icon={kind === 'cron' ? <Clock size={12} className='text-text-muted' /> : kind === 'webhook' ? <Link2 size={12} className='text-text-muted' /> : <Hash size={12} className='text-accent' />}
        title={t.title}
        fresh={fresh}
        selected={t.id === activeId}
        muted={archivedRow}
        right={waiting
          ? <span className='rounded-full bg-warning px-1.5 font-medium text-white'>waiting for you</span>
          : fresh ? <span className='rounded-full bg-accent px-1.5 font-medium text-white'>{t.unread_count} new</span> : relative(t.updated_at)}
        sub={passageOf(t, messages)}
        italicSub
        onOpen={() => pick(t.id)}
        actions={[archivedRow
          ? { label: `Reopen ${t.title}`, icon: <RotateCcw size={12} />, run: () => onArchive(t, false) }
          : { label: `Done with ${t.title}`, icon: <Check size={12} />, run: () => onArchive(t, true) }]}
      />
    )
  }

  return (
    <div className='relative flex shrink-0 items-center'>
      <button
        ref={btnRef}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid='threads-pill'
        aria-label={`Threads${active.length ? ` (${active.length})` : ''}${unread ? `, ${unread} new` : ''}`}
        title='Threads of this chat'
        className={`relative flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${open ? 'border-accent/40 bg-accent-subtle text-accent' : 'border-border text-text-muted hover:border-accent/40 hover:text-text-primary'}`}
      >
        <Hash size={11} />
        {active.length > 0 && <span>{active.length}</span>}
        {unread > 0 && <span className='absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent' data-testid='threads-pill-unread' />}
      </button>

      <Popover anchor={btnRef} open={open} onClose={close} className='w-80 max-w-[calc(100vw-16px)] max-h-[75vh] overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-md/5'>
        <div onClick={(e) => e.stopPropagation()} data-testid='threads-popover'>
          {active.map((t) => row(t, false))}
          <CreateRow
            label='New thread'
            hint='Ask something on the side, without cluttering this chat. You can also select a passage and press #.'
            onClick={() => { close(); onNew() }}
          />

          <div className='my-1 h-px bg-border' />
          <div className='flex items-center gap-1 px-1'>
            {archived.length > 0 && (
              <button onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived} className='flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[11.5px] text-text-muted hover:bg-surface2 hover:text-text-primary'>
                Archived ({archived.length}) <ChevronRight size={12} className={`transition-transform ${showArchived ? 'rotate-90' : ''}`} />
              </button>
            )}
            <button onClick={() => { close(); navigate('/routines') }} className='ml-auto flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[11.5px] text-text-muted hover:bg-surface2 hover:text-text-primary'>
              All routines <ChevronRight size={12} />
            </button>
          </div>
          {showArchived && archived.map((t) => row(t, true))}
        </div>
      </Popover>
    </div>
  )
}

/** The passage a thread was opened on, on one line. */
function passageOf(thread: Conversation, messages: Message[]): string {
  const source = messages.find((m) => m.id === thread.parent_message_id)
  return source ? (source.role === 'assistant' ? source.result ?? source.content : source.content).replace(/\s+/g, ' ').trim() : ''
}
