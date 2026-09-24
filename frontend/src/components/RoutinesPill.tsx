import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, Link2, Loader2, Plus, Repeat, Settings2, Square, Zap } from 'lucide-react'
import { api, type Run } from '../api'
import { useChatStore } from '../stores/chatStore'
import { describeSchedule, relative } from '../lib/runs'
import Popover from './Popover'
import type { Routine } from './RoutineForm'

/**
 * The chat's routines, from the chat.
 *
 * One small control in the title bar says what runs here without you — a count
 * at rest, a spinner while a run is in flight — and opens to the two things
 * that used to need a page: stop a run, and pause / fire / edit a routine.
 * Creating one is here too, pre-addressed to this chat. The full list stays
 * one click away for the rare day it is wanted.
 */
export default function RoutinesPill({
  conversationId,
  hasRoutines,
}: {
  conversationId?: string
  hasRoutines: boolean
}) {
  const navigate = useNavigate()
  const runs = useChatStore((s) => (conversationId ? s.activeRuns[conversationId] : undefined)) ?? []
  const [open, setOpen] = useState(false)
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const btnRef = useRef<HTMLButtonElement>(null)

  // Fetched when opened, not on mount: most visits to a chat never look here.
  const load = useCallback(async () => {
    if (!conversationId) return
    try {
      const [crons, hooks] = await Promise.all([api.getCrons(), api.getWebhooks()])
      const mine: Routine[] = [
        ...crons.filter((c) => c.conversation_id === conversationId).map((row): Routine => ({ kind: 'cron', row })),
        ...hooks.filter((h) => h.conversation_id === conversationId).map((row): Routine => ({ kind: 'webhook', row })),
      ]
      mine.sort((a, b) => a.row.name.localeCompare(b.row.name))
      setRoutines(mine)
    } catch {
      setRoutines([])
    }
  }, [conversationId])
  useEffect(() => {
    if (open) load()
  }, [open, load])
  useEffect(() => { setRoutines(null); setOpen(false) }, [conversationId])

  if (!conversationId || (!hasRoutines && runs.length === 0)) return null
  const running = runs.length

  async function stop(run: Run) {
    setBusy((b) => ({ ...b, [run.id]: true }))
    try {
      await api.stopRun(run.id)
    } finally {
      setBusy((b) => ({ ...b, [run.id]: false }))
    }
  }
  async function toggle(r: Routine) {
    if (r.kind === 'cron') await api.updateCron(r.row.id, { enabled: !r.row.enabled })
    else await api.updateWebhook(r.row.id, { enabled: !r.row.enabled })
    await load()
    // The sidebar's has_cron/has_webhook flags come from the list.
    useChatStore.getState().loadConversations()
  }
  async function fire(r: Routine) {
    if (r.kind === 'cron') await api.triggerCron(r.row.id)
    else await api.triggerWebhook(r.row.id)
    setOpen(false)
  }

  return (
    <div className='relative flex items-center shrink-0'>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        data-testid='routines-pill'
        className={
          running
            ? `flex items-center gap-1.5 rounded-full border border-accent/30 px-2 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent-subtle ${open ? 'bg-accent-subtle' : ''}`
            : `flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface2 hover:text-text-primary ${open ? 'bg-surface2 text-text-primary' : ''}`
        }
        title={running ? `${running} run${running > 1 ? 's' : ''} in progress` : 'Routines of this chat'}
      >
        {running ? <Loader2 size={11} className='animate-spin' /> : <Repeat size={13} />}
        {running ? `${running} running` : null}
      </button>

      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} className='w-80 max-w-[calc(100vw-16px)] rounded-xl border border-border bg-surface p-1 shadow-md/5'>
        <div onClick={(e) => e.stopPropagation()} data-testid='routines-popover'>
          {runs.length > 0 && (
            <div className='border-b border-border pb-1 mb-1'>
              {runs.map((run) => (
                <div key={run.id} className='flex items-center gap-2 rounded-lg px-2 py-1.5'>
                  <Loader2 size={12} className='shrink-0 animate-spin text-accent' />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-xs text-text-primary'>{run.source_name}</span>
                    <span className='block text-[10.5px] text-text-muted'>
                      {run.status === 'needs_you' ? 'waiting for you' : `since ${relative(run.started_at).replace(' ago', '')}`}
                    </span>
                  </span>
                  <button
                    onClick={() => stop(run)}
                    disabled={busy[run.id]}
                    className='flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface2 hover:text-danger disabled:opacity-40'
                    title='Stop this run'
                  >
                    <Square size={10} fill='currentColor' /> Stop
                  </button>
                </div>
              ))}
            </div>
          )}

          {routines === null ? (
            <div className='flex items-center gap-2 px-2 py-2 text-xs text-text-muted'><Loader2 size={12} className='animate-spin' /> Loading…</div>
          ) : routines.length === 0 ? (
            <div className='px-2 py-2 text-xs text-text-muted'>No routine posts here.</div>
          ) : (
            routines.map((r) => {
              const Icon = r.kind === 'webhook' ? Link2 : Clock
              return (
                <div key={`${r.kind}-${r.row.id}`} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${r.row.enabled ? '' : 'opacity-60'}`} data-testid='routines-popover-row'>
                  <Icon size={12} className='shrink-0 text-text-muted' />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-xs text-text-primary'>{r.row.name}</span>
                    <span className='block truncate text-[10.5px] text-text-muted'>
                      {r.kind === 'cron' ? describeSchedule(r.row.schedule) : 'when called'}
                      {r.row.last_run ? ` · last ${relative(r.row.last_run)}` : ''}
                    </span>
                  </span>
                  <button
                    role='switch'
                    aria-checked={!!r.row.enabled}
                    aria-label={`${r.row.enabled ? 'Pause' : 'Resume'} ${r.row.name}`}
                    onClick={() => toggle(r)}
                    className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${r.row.enabled ? 'bg-success' : 'bg-border'}`}
                  >
                    <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${r.row.enabled ? 'left-[14px]' : 'left-0.5'}`} />
                  </button>
                  <button onClick={() => fire(r)} title='Run now' className='rounded-md p-1 text-text-muted/70 hover:bg-surface2 hover:text-accent'><Zap size={12} /></button>
                  <button onClick={() => { setOpen(false); navigate(`/routines?edit=${r.row.id}`) }} title='Edit this routine' className='rounded-md p-1 text-text-muted/70 hover:bg-surface2 hover:text-text-primary'><Settings2 size={12} /></button>
                </div>
              )
            })
          )}

          <div className='mt-1 flex items-center justify-between border-t border-border pt-1'>
            <button
              onClick={() => { setOpen(false); navigate(`/routines?new=cron&conversation_id=${conversationId}`) }}
              className='inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-text-secondary hover:bg-surface2 hover:text-text-primary'
            >
              <Plus size={12} /> New routine here
            </button>
            <button
              onClick={() => { setOpen(false); navigate('/routines') }}
              className='rounded-lg px-2 py-1.5 text-xs text-text-muted hover:bg-surface2 hover:text-text-primary'
            >
              All routines
            </button>
          </div>
        </div>
      </Popover>
    </div>
  )
}
