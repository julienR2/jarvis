import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronRight, Hash, RotateCcw } from 'lucide-react'
import type { Conversation, Message } from '../api'
import { relative } from '../lib/runs'
import ChatRoutines from './ChatRoutines'
import { CreateRow, ListHeading, SubChatRow } from './SubChatRow'
import { isActiveThread } from '../lib/threads'
import Popover from './Popover'

interface Props {
  conversationId: string
  /** The chat's side chats: opened from its passages, or blank from here. */
  threads: Conversation[]
  /** The threads (side chats) the chat's routines run in. */
  routines: Conversation[]
  /** The chat's loaded messages, for the passage each thread came from. */
  messages: Message[]
  activeId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onArchive: (thread: Conversation, archived: boolean) => void
  /** Open the list now (it was asked for from elsewhere). */
  openSignal?: boolean
  onSignalHandled?: () => void
}

/**
 * A chat's side chats and routines, in its title bar: the way back to them
 * without scrolling to where they started. Side chats first, most recent
 * first — put away (Done) or a week untouched, they fold under Archived —
 * then the chat's routines (ChatRoutines): a routine is a side chat of the
 * whole chat that Jarvis writes in on its own. Each section ends with the way
 * to start one, and a line on what it is for.
 */
export default function ThreadsPill({ conversationId, threads, routines, messages, activeId, onOpen, onNew, onArchive, openSignal, onSignalHandled }: Props) {
  const [open, setOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  useEffect(() => { if (!open) setShowArchived(false) }, [open])
  // Asked to open from elsewhere (the sidebar's routine mark): only the copy
  // on screen does — the phone's and the desktop's title bars both hold one.
  useEffect(() => {
    if (!openSignal || !btnRef.current?.offsetParent) return
    setOpen(true)
    onSignalHandled?.()
  }, [openSignal])

  const byRecent = (a: Conversation, b: Conversation) => b.updated_at - a.updated_at
  const active = threads.filter((t) => isActiveThread(t)).sort(byRecent)
  const archived = threads.filter((t) => !isActiveThread(t)).sort(byRecent)
  const unread = active.reduce((n, t) => n + (t.id === activeId ? 0 : t.unread_count), 0)

  const pick = (id: string) => {
    setOpen(false)
    onOpen(id)
  }
  const row = (t: Conversation, archivedRow: boolean) => {
    const fresh = t.id !== activeId && t.unread_count > 0
    return (
      <SubChatRow
        key={t.id}
        testId='thread-row'
        icon={<Hash size={12} className='text-accent' />}
        title={t.title}
        fresh={fresh}
        selected={t.id === activeId}
        muted={archivedRow}
        right={fresh ? <span className='rounded-full bg-accent px-1.5 font-medium text-white'>{t.unread_count} new</span> : relative(t.updated_at)}
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
        onClick={() => setOpen((o) => !o)}
        data-testid='threads-pill'
        aria-label={`Side chats and routines${active.length ? ` (${active.length})` : ''}${unread ? `, ${unread} new` : ''}`}
        title='Side chats and routines of this chat'
        className={`relative flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${open ? 'border-accent/40 bg-accent-subtle text-accent' : 'border-border text-text-muted hover:border-accent/40 hover:text-text-primary'}`}
      >
        <Hash size={11} />
        {active.length > 0 && <span>{active.length}</span>}
        {unread > 0 && <span className='absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent' data-testid='threads-pill-unread' />}
      </button>

      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} className='w-80 max-w-[calc(100vw-16px)] max-h-[75vh] overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-md/5'>
        <div onClick={(e) => e.stopPropagation()} data-testid='threads-popover'>
          <ListHeading>Side chats</ListHeading>
          {active.map((t) => row(t, false))}
          <CreateRow
            label='New side chat'
            hint='Ask something on the side, without cluttering this chat. You can also select a passage and press #.'
            onClick={() => { setOpen(false); onNew() }}
          />

          <div className='my-1 h-px bg-border' />
          <ChatRoutines conversationId={conversationId} threads={routines} activeId={activeId} onOpenThread={onOpen} onNavigate={() => setOpen(false)} />

          <div className='my-1 h-px bg-border' />
          <div className='flex items-center gap-1 px-1'>
            {archived.length > 0 && (
              <button onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived} className='flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[11.5px] text-text-muted hover:bg-surface2 hover:text-text-primary'>
                Archived side chats ({archived.length}) <ChevronRight size={12} className={`transition-transform ${showArchived ? 'rotate-90' : ''}`} />
              </button>
            )}
            <button onClick={() => { setOpen(false); navigate(`/routines?conversation_id=${conversationId}`) }} className='ml-auto flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[11.5px] text-text-muted hover:bg-surface2 hover:text-text-primary'>
              All routines <ChevronRight size={12} />
            </button>
          </div>
          {showArchived && archived.map((t) => row(t, true))}
        </div>
      </Popover>
    </div>
  )
}

/** The passage a side chat was opened on, on one line. */
function passageOf(thread: Conversation, messages: Message[]): string {
  const source = messages.find((m) => m.id === thread.parent_message_id)
  return source ? (source.role === 'assistant' ? source.result ?? source.content : source.content).replace(/\s+/g, ' ').trim() : ''
}
