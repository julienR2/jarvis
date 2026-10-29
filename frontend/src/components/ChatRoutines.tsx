import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, Link2, Loader2, Plus } from 'lucide-react'
import { api } from '../api'
import { useChatStore } from '../stores/chatStore'
import { describeSchedule } from '../lib/runs'
import { routinePath, type Routine } from '../lib/routines'

/** At most this many in the menu; the rest are one click away. */
const SHOWN = 3

/**
 * The chat's routines, in its ⋯ menu: what posts here and when, paused or not.
 * Fetched when the menu opens — most visits to a chat never look here. A row
 * opens the routine; everything else lives on the Routines page, filtered to
 * this chat.
 */
export default function ChatRoutines({ conversationId, onNavigate }: {
  conversationId: string
  /** Called before leaving for another page, so the menu can close. */
  onNavigate: () => void
}) {
  const navigate = useNavigate()
  const [routines, setRoutines] = useState<Routine[] | null>(null)

  const load = useCallback(async () => {
    try {
      const [crons, hooks] = await Promise.all([api.getCrons(), api.getWebhooks()])
      const mine: Routine[] = [
        ...crons.filter((c) => c.conversation_id === conversationId || c.thread_id === conversationId).map((row): Routine => ({ kind: 'cron', row })),
        ...hooks.filter((h) => h.conversation_id === conversationId || h.thread_id === conversationId).map((row): Routine => ({ kind: 'webhook', row })),
      ]
      mine.sort((a, b) => a.row.name.localeCompare(b.row.name))
      setRoutines(mine)
    } catch {
      setRoutines([])
    }
  }, [conversationId])
  useEffect(() => { load() }, [load])

  async function toggle(r: Routine) {
    if (r.kind === 'cron') await api.updateCron(r.row.id, { enabled: !r.row.enabled })
    else await api.updateWebhook(r.row.id, { enabled: !r.row.enabled })
    await load()
    // The sidebar's routine flag comes from the list.
    useChatStore.getState().loadConversations()
  }
  function go(path: string) {
    onNavigate()
    navigate(path)
  }

  return (
    <div className='px-1 py-1' data-testid='chat-routines'>
      <div className='flex items-center justify-between px-1 pb-1'>
        <span className='text-[11px] text-text-muted font-medium'>Routines</span>
        <button
          onClick={() => go(`/routines/new?kind=cron&conversation_id=${conversationId}`)}
          title='New routine here'
          aria-label='New routine here'
          className='rounded-md p-0.5 text-text-muted hover:bg-surface2 hover:text-text-primary'
        >
          <Plus size={12} />
        </button>
      </div>
      {routines === null ? (
        <div className='flex items-center gap-2 px-1 py-1 text-[11px] text-text-muted'><Loader2 size={11} className='animate-spin' /> Loading…</div>
      ) : routines.length === 0 ? (
        <div className='px-1 py-1 text-[11px] text-text-muted'>None yet</div>
      ) : (
        <>
          {routines.slice(0, SHOWN).map((r) => {
            const Icon = r.kind === 'webhook' ? Link2 : Clock
            return (
              <div key={`${r.kind}-${r.row.id}`} className='flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-surface2' data-testid='chat-routines-row'>
                <button
                  onClick={() => go(routinePath(r))}
                  title='Open this routine'
                  className={`flex min-w-0 flex-1 items-center gap-2 text-left ${r.row.enabled ? '' : 'opacity-60'}`}
                >
                  <Icon size={12} className='shrink-0 text-text-muted' />
                  <span className='min-w-0 flex-1 truncate text-xs text-text-primary'>{r.row.name}</span>
                  <span className='shrink-0 text-[10.5px] text-text-muted'>
                    {r.kind === 'cron' ? describeSchedule(r.row.schedule) : 'when called'}
                  </span>
                </button>
                <button
                  role='switch'
                  aria-checked={!!r.row.enabled}
                  aria-label={`${r.row.enabled ? 'Pause' : 'Resume'} ${r.row.name}`}
                  onClick={() => toggle(r)}
                  className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${r.row.enabled ? 'bg-success' : 'bg-border'}`}
                >
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${r.row.enabled ? 'left-[14px]' : 'left-0.5'}`} />
                </button>
              </div>
            )
          })}
          <button
            onClick={() => go(`/routines?conversation_id=${conversationId}`)}
            className='w-full rounded-lg px-1 py-1 text-left text-[11px] text-text-muted hover:bg-surface2 hover:text-text-primary'
          >
            {routines.length > SHOWN ? `All ${routines.length} routines` : 'Open in Routines'}
          </button>
        </>
      )}
    </div>
  )
}
