import { AlertCircle, Check, Loader2, MessageCircleQuestion } from 'lucide-react'
import type { Run } from '../api'
import { duration } from '../lib/runs'

/** A run's state in one small word, with how long it took where that means something. */
export default function StatusPill({ run }: { run: Pick<Run, 'status' | 'started_at' | 'ended_at'> }) {
  const base = 'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] font-medium'
  switch (run.status) {
    case 'running':
      return <span className={`${base} border-accent/30 text-accent`}><Loader2 size={9} className='animate-spin' /> running · {duration(run.started_at, null)}</span>
    case 'needs_you':
      return <span className={`${base} border-warning/40 text-warning`}><MessageCircleQuestion size={9} /> waiting for you</span>
    case 'done':
      return <span className={`${base} border-success/40 text-success`}><Check size={9} /> done · {duration(run.started_at, run.ended_at)}</span>
    case 'error':
      return <span className={`${base} border-danger/40 text-danger`}><AlertCircle size={9} /> failed</span>
    case 'stopped':
      return <span className={`${base} border-border text-text-muted`}>stopped</span>
    case 'interrupted':
      return <span className={`${base} border-border text-text-muted`}>interrupted</span>
  }
}
