import { Clock, Link2, X } from 'lucide-react'
import ScheduleFields, { FIELD } from './ScheduleFields'
import { Switch } from './RoutineCard'
import { buildSchedule, parseSchedule, type Schedule } from '../lib/schedule'

/** A routine being started from the composer: what the input holds is its prompt. */
export interface RoutineSetup {
  kind: 'cron' | 'webhook'
  name: string
  schedule: Schedule
  /** Webhooks: each call opens a thread of its own. */
  perCall: boolean
}

/** What the composer hands over to create the routine. */
export interface NewRoutine {
  kind: 'cron' | 'webhook'
  name: string
  /** The cron expression; empty for a webhook. */
  schedule: string
  prompt: string
  thread_per_fire: boolean
}

export function newSetup(kind: 'cron' | 'webhook'): RoutineSetup {
  return { kind, name: '', schedule: parseSchedule(''), perCall: false }
}

/** A name from the prompt's first words, when none was given: "check-the-guincho-forecast". */
function nameFrom(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-')
  return slug || 'routine'
}

/** The routine to create, or why it can't be yet. */
export function routineFrom(setup: RoutineSetup, prompt: string): NewRoutine | string {
  const schedule = setup.kind === 'cron' ? buildSchedule(setup.schedule) : ''
  if (setup.kind === 'cron' && !schedule) return 'Say when it runs.'
  if (!prompt.trim()) return 'Say what Jarvis should do on each run.'
  return {
    kind: setup.kind,
    name: setup.name.trim() || nameFrom(prompt),
    schedule,
    prompt: prompt.trim(),
    thread_per_fire: setup.kind === 'webhook' && setup.perCall,
  }
}

/**
 * Above an empty composer: the way to make this a routine instead of a
 * message — the same chat, fed on a schedule or by a webhook.
 */
export function RoutinePills({ onPick }: { onPick: (kind: 'cron' | 'webhook') => void }) {
  const pill = 'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-text-muted/50 hover:text-text-primary'
  return (
    <div className='mb-2 flex flex-wrap items-center gap-1.5' data-testid='routine-pills'>
      <button type='button' className={pill} onClick={() => onPick('cron')} title='Jarvis gets this message on a schedule'>
        <Clock size={12} /> Every…
      </button>
      <button type='button' className={pill} onClick={() => onPick('webhook')} title='Jarvis gets this message, with what was sent, whenever its link is called'>
        <Link2 size={12} /> When called
      </button>
    </div>
  )
}

/**
 * The routine's settings, at the top of the composer while one is being
 * started: when it runs, or that it runs when called, and its name. What is
 * typed below is the message it gets on each run; Send creates it.
 */
export function RoutineStrip({ setup, onChange, onClose, error }: {
  setup: RoutineSetup
  onChange: (setup: RoutineSetup) => void
  onClose: () => void
  error?: string
}) {
  const set = (patch: Partial<RoutineSetup>) => onChange({ ...setup, ...patch })
  return (
    <div className='border-b border-border px-4 pt-3 pb-2.5 animate-fade-in' data-testid='routine-strip'>
      <div className='mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted'>
        {setup.kind === 'cron' ? <Clock size={11} /> : <Link2 size={11} />}
        {setup.kind === 'cron' ? 'A routine on a schedule' : 'A routine run when called'}
        <button type='button' onClick={onClose} aria-label='Not a routine' title='Back to a plain message' className='ml-auto rounded p-0.5 text-text-muted transition-colors hover:text-text-primary'>
          <X size={13} />
        </button>
      </div>
      <div className='flex flex-wrap items-center gap-1.5 text-[13px]'>
        {setup.kind === 'cron' ? (
          <ScheduleFields schedule={setup.schedule} onChange={(patch) => set({ schedule: { ...setup.schedule, ...patch } })} />
        ) : (
          <label className='inline-flex items-center gap-2 text-[12.5px] text-text-secondary'>
            <Switch on={setup.perCall} label='A new thread for each call' onClick={() => set({ perCall: !setup.perCall })} />
            A new thread for each call
          </label>
        )}
        <input
          value={setup.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder='Name (optional)'
          aria-label='Routine name'
          className={`${FIELD} ml-auto w-40`}
        />
      </div>
      {error && <div role='alert' className='mt-1.5 text-[12px] text-danger'>{error}</div>}
    </div>
  )
}
