import { useEffect, useRef, useState } from 'react'
import { Loader2, Square } from 'lucide-react'
import { api, type Run } from '../api'
import { useChatStore } from '../stores/chatStore'
import { relative } from '../lib/runs'
import Popover from './Popover'

/**
 * The chat's runs in flight, in the title bar — only while there are some.
 * A spinner and a count, opening to Stop for each. The routines themselves
 * live in the ⋯ menu (ChatRoutines).
 */
export default function RunsPill({ conversationId }: { conversationId?: string }) {
  const runs = useChatStore((s) => (conversationId ? s.activeRuns[conversationId] : undefined)) ?? []
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { setOpen(false) }, [conversationId])

  if (!conversationId || runs.length === 0) return null
  const running = runs.length

  async function stop(run: Run) {
    setBusy((b) => ({ ...b, [run.id]: true }))
    try {
      await api.stopRun(run.id)
    } finally {
      setBusy((b) => ({ ...b, [run.id]: false }))
    }
  }

  return (
    <div className='relative flex items-center shrink-0'>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        data-testid='runs-pill'
        className={`flex items-center gap-1.5 rounded-full border border-accent/30 px-2 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent-subtle ${open ? 'bg-accent-subtle' : ''}`}
        title={`${running} run${running > 1 ? 's' : ''} in progress`}
      >
        <Loader2 size={11} className='animate-spin' />
        {running} running
      </button>

      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} className='w-72 max-w-[calc(100vw-16px)] rounded-xl border border-border bg-surface p-1 shadow-md/5'>
        <div onClick={(e) => e.stopPropagation()} data-testid='runs-popover'>
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
      </Popover>
    </div>
  )
}
