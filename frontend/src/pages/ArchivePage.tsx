import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArchiveRestore, Clock, Link2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { SidebarToggle } from '../components/ContentLayout'
import type { Conversation } from '../api'
import { relative } from '../lib/runs'
import { archiveDeadline, ARCHIVE_KEEP_DAYS, routineKindOf } from '../lib/threads'
import { useChatStore } from '../stores/chatStore'

/**
 * What was put away: each archived conversation once — those archived with
 * it (its threads, its routines) count under it rather than as rows of their
 * own. Kept a week, then deleted for good with their files; until then a
 * click brings one back with everything that went with it, and opening one
 * to write in it does too.
 */
export default function ArchivePage() {
  const navigate = useNavigate()
  const conversations = useChatStore(useShallow((s) => s.order.map((id) => s.conversations[id]).filter((c): c is Conversation => !!c)))
  const byId = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations])
  const rows = useMemo(() => {
    // A row for each archived conversation whose parent is not archived too.
    const roots = conversations.filter((c) => c.archived_at && !(c.parent_id && byId.get(c.parent_id)?.archived_at))
    const under = (root: Conversation) => {
      let n = 0
      const walk = (id: string, seen: Set<string>) => {
        for (const c of conversations) {
          if (c.parent_id !== id || seen.has(c.id) || !c.archived_at) continue
          n++
          walk(c.id, new Set(seen).add(c.id))
        }
      }
      walk(root.id, new Set([root.id]))
      return n
    }
    return roots
      .map((c) => ({ conv: c, threads: under(c) }))
      .sort((a, b) => (b.conv.archived_at ?? 0) - (a.conv.archived_at ?? 0))
  }, [conversations, byId])

  return (
    <div className='flex flex-col h-full' data-testid='archive-page'>
      <div className='shrink-0 border-b border-border'>
        <div className='flex items-center gap-2 h-12 px-3 md:px-6'>
          <SidebarToggle />
          <h1 className='min-w-0 flex-1 truncate text-sm font-medium text-text-primary'>
            Archive
            {rows.length > 0 && <span className='ml-2 text-xs font-normal text-text-muted'>{rows.length}</span>}
          </h1>
        </div>
      </div>

      <div className='flex-1 overflow-y-auto'>
        <div className='max-w-3xl mx-auto px-4 md:px-6 py-6 flex flex-col gap-5'>
          <section className='rounded-xl bg-surface2/70 px-4 py-3 text-[13.5px] leading-relaxed text-text-secondary'>
            <strong className='font-semibold text-text-primary'>What you put away.</strong>{' '}
            An archived chat goes with its threads and routines (paused). It is kept here {ARCHIVE_KEEP_DAYS} days, then deleted
            for good with its files. Bring it back, or open it and write: it comes back on its own.
          </section>

          {rows.length === 0 ? (
            <div className='py-10 text-center text-sm text-text-muted'>Nothing archived.</div>
          ) : (
            <ul className='flex flex-col divide-y divide-border rounded-xl border border-border bg-surface'>
              {rows.map(({ conv, threads }) => {
                const kind = routineKindOf(conv)
                const parent = conv.parent_id ? byId.get(conv.parent_id) : undefined
                return (
                  <li key={conv.id} className='flex items-center gap-3 px-4 py-3' data-testid='archive-row'>
                    <button onClick={() => navigate(`/c/${conv.id}`)} className='min-w-0 flex-1 text-left'>
                      <span className='flex items-center gap-1.5 text-sm text-text-primary'>
                        <span className='truncate'>{conv.title}</span>
                        {kind === 'cron' && <Clock size={11} className='shrink-0 text-text-muted' />}
                        {kind === 'webhook' && <Link2 size={11} className='shrink-0 text-text-muted' />}
                      </span>
                      <span className='mt-0.5 block truncate text-[11.5px] text-text-muted'>
                        Archived {relative(conv.archived_at!)}
                        {threads > 0 && ` · with ${threads} thread${threads > 1 ? 's' : ''}`}
                        {parent && ` · under ${parent.title}`}
                        {' · '}
                        deleted {archiveDeadline(conv.archived_at!)}
                      </span>
                    </button>
                    <button
                      onClick={() => useChatStore.getState().setArchived(conv.id, false)}
                      aria-label={`Bring back ${conv.title}`}
                      className='inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface2 hover:text-text-primary transition-colors'
                    >
                      <ArchiveRestore size={13} /> Bring back
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
