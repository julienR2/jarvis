import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Clock, Copy, Link2, Loader2, MoreHorizontal, Repeat, Trash2, Zap } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api, type Conversation, type Effort } from '../api'
import { useChatStore } from '../stores/chatStore'
import { describeSchedule } from '../lib/runs'
import { HOOK_NOTIFY, NOTIFY_OPTIONS, updateRoutine, webhookUrl, type Notify, type Routine, type RoutineKind } from '../lib/routines'
import { buildSchedule, DAY_NAMES, FREQ_LABELS, parseSchedule, type Freq, type Schedule } from '../lib/schedule'
import ModelSelector, { DEFAULT_EFFORT, useModelCatalogue } from './ModelSelector'
import Popover from './Popover'

/** What the card edits. */
interface Draft {
  kind: RoutineKind
  name: string
  schedule: Schedule
  prompt: string
  conversation_id: string | null
  notify: Notify
  model: string
  effort: Effort
}

function draftFrom(routine: Routine | null, thread: Conversation, fallbackModel: string): Draft {
  if (!routine) {
    return {
      kind: 'cron',
      name: '',
      schedule: parseSchedule(''),
      prompt: '',
      conversation_id: thread.parent_id ?? null,
      notify: 'auto',
      model: fallbackModel,
      effort: DEFAULT_EFFORT,
    }
  }
  const r = routine.row
  return {
    kind: routine.kind,
    name: r.name,
    schedule: parseSchedule(routine.kind === 'cron' ? routine.row.schedule : ''),
    prompt: r.prompt,
    conversation_id: r.conversation_id,
    notify: thread.notify,
    model: r.model ?? fallbackModel,
    effort: r.effort ?? DEFAULT_EFFORT,
  }
}

/** The fields a save would send, for telling whether anything changed. */
function signature(d: Draft): string {
  return JSON.stringify([d.name.trim(), d.kind === 'cron' ? buildSchedule(d.schedule) : '', d.prompt, d.conversation_id, d.notify, d.model, d.effort])
}

/**
 * The routine, as a card in its own thread — the thread's first "message".
 *
 * It is the form: in a new thread it is filled in and creates the routine; in
 * an existing one it shows the routine as it stands and edits it in place. Either
 * way, typing to Jarvis below does the same, and the card follows: it is
 * re-read whenever the routine changes, unless it holds unsaved edits.
 */
export function RoutineCard({
  routine,
  thread,
  onChanged,
  compact,
}: {
  routine: Routine | null
  thread: Conversation
  onChanged: () => void
  /** In the title bar's popover: no outer margin, no hint below. */
  compact?: boolean
}) {
  const navigate = useNavigate()
  const fallbackModel = useModelCatalogue().default
  const initial = useMemo(() => draftFrom(routine, thread, fallbackModel), [routine, thread, fallbackModel])
  const [draft, setDraft] = useState(initial)
  const dirty = signature(draft) !== signature(initial)
  // Follow the routine as it changes elsewhere (Jarvis, another tab) — but
  // never under someone's unsaved edits.
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    if (!dirtyRef.current) setDraft(initial)
  }, [initial])

  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const isNew = !routine
  const set = (patch: Partial<Draft>) => {
    setError('')
    setDraft((d) => ({ ...d, ...patch }))
  }
  const setSchedule = (patch: Partial<Schedule>) => set({ schedule: { ...draft.schedule, ...patch } })

  const chats = useChatStore(useShallow((s) => s.order.map((id) => s.conversations[id]).filter((c) => c && c.kind !== 'thread')))
  const sorted = useMemo(() => [...chats].sort((a, b) => a.title.localeCompare(b.title)), [chats])
  const cronExpr = draft.kind === 'cron' ? buildSchedule(draft.schedule) : ''
  const words = cronExpr ? describeSchedule(cronExpr) : ''

  function problem(): string | null {
    if (!draft.name.trim()) return 'Give it a name.'
    if (draft.kind === 'cron' && !cronExpr) return 'Say when it runs.'
    if (!draft.prompt.trim()) return 'Say what Jarvis should do on each run.'
    return null
  }

  async function submit() {
    const p = problem()
    if (p) return setError(p)
    setBusy(true)
    try {
      const common = {
        name: draft.name.trim(),
        prompt: draft.prompt,
        model: draft.model,
        effort: draft.effort,
        conversation_id: draft.conversation_id,
      }
      if (isNew) {
        if (draft.kind === 'cron') await api.createCron({ ...common, schedule: cronExpr, notify: draft.notify, thread_id: thread.id })
        else await api.createWebhook({ ...common, notify: HOOK_NOTIFY[draft.notify], thread_id: thread.id })
      } else {
        await updateRoutine(routine!, { ...common, ...(draft.kind === 'cron' ? { schedule: cronExpr } : {}), notify: draft.notify })
      }
      // The thread's name, notify mode and routine come back from the server.
      await useChatStore.getState().loadConversations()
      onChanged()
    } catch (err: any) {
      setError(err.message ?? 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  async function toggle() {
    if (!routine) return
    await updateRoutine(routine, { enabled: !routine.row.enabled })
    onChanged()
  }

  async function fire() {
    if (!routine) return
    if (routine.kind === 'cron') await api.triggerCron(routine.row.id)
    else await api.triggerWebhook(routine.row.id)
    window.__jarvisToast?.info(`${routine.row.name} is running.`)
  }

  async function remove() {
    if (!routine) return
    if (!window.confirm(`Delete the routine “${routine.row.name}”? It stops running; this thread and what it wrote stay.`)) return
    if (routine.kind === 'cron') await api.deleteCron(routine.row.id)
    else await api.deleteWebhook(routine.row.id)
    await useChatStore.getState().loadConversations()
    onChanged()
  }

  async function discard() {
    await useChatStore.getState().deleteConversation(thread.id)
    navigate(thread.parent_id ? `/c/${thread.parent_id}` : '/routines', { replace: true })
  }

  const enabled = !!routine?.row.enabled
  const Icon = draft.kind === 'webhook' ? Link2 : isNew ? Repeat : Clock
  const field = 'rounded-lg border border-border bg-bg px-2 py-1 text-[13px] text-text-primary transition-colors hover:border-text-muted/60 focus:border-accent focus:outline-none'

  return (
    <div className={compact ? '' : 'my-5 animate-fade-in'} data-testid='routine-card'>
      <div className={`overflow-hidden rounded-2xl border bg-surface ${compact ? 'border-transparent' : 'border-border shadow-sm'}`}>
        {/* Name, and whether it runs. */}
        <div className='flex items-center gap-3 px-4 pt-4'>
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${isNew || enabled ? 'bg-accent/10 text-accent' : 'bg-surface2 text-text-muted'}`}>
            <Icon size={16} />
          </span>
          <div className='min-w-0 flex-1'>
            <input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={isNew ? 'Name your routine' : 'Name'}
              aria-label='Name'
              className='w-full bg-transparent text-[15px] font-medium text-text-primary placeholder:text-text-muted focus:outline-none'
            />
            <div className='text-[11.5px] text-text-muted'>
              {isNew ? 'A new routine' : enabled ? (words || 'when its link is called') : 'Paused'}
            </div>
          </div>
          {routine && <Switch on={enabled} label={`${enabled ? 'Pause' : 'Resume'} ${routine.row.name}`} onClick={toggle} />}
        </div>

        {/* When, where, who hears — written as sentences. */}
        <div className='mt-3 grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2.5 px-4 text-[13px]'>
          <span className='text-text-muted'>Runs</span>
          <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
            {isNew && (
              <span className='inline-flex rounded-lg border border-border bg-bg p-0.5' role='radiogroup' aria-label='Trigger'>
                {([['cron', 'On a schedule'], ['webhook', 'When called']] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type='button'
                    role='radio'
                    aria-checked={draft.kind === k}
                    onClick={() => set({ kind: k })}
                    className={`rounded-md px-2 py-0.5 text-[12px] transition-colors ${draft.kind === k ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}
                  >
                    {label}
                  </button>
                ))}
              </span>
            )}
            {draft.kind === 'cron' ? (
              <>
                <select value={draft.schedule.freq} onChange={(e) => setSchedule({ freq: e.target.value as Freq, cron: cronExpr || draft.schedule.cron })} className={field} aria-label='How often'>
                  {FREQ_LABELS.map(([f, label]) => <option key={f} value={f}>{label}</option>)}
                </select>
                {draft.schedule.freq === 'weekly' && (
                  <select value={draft.schedule.day} onChange={(e) => setSchedule({ day: Number(e.target.value) })} className={field} aria-label='Day'>
                    {DAY_NAMES.map((d, i) => <option key={d} value={i}>on {d}</option>)}
                  </select>
                )}
                {draft.schedule.freq === 'hourly' && (
                  <label className='inline-flex items-center gap-1 text-text-muted'>
                    at :
                    <input type='number' min={0} max={59} value={draft.schedule.minute} onChange={(e) => setSchedule({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} className={`${field} w-14`} aria-label='Minute' />
                  </label>
                )}
                {['daily', 'weekdays', 'weekly'].includes(draft.schedule.freq) && (
                  <input type='time' value={draft.schedule.time} onChange={(e) => setSchedule({ time: e.target.value })} className={field} aria-label='Time' />
                )}
                {draft.schedule.freq === 'custom' && (
                  <input value={draft.schedule.cron} onChange={(e) => setSchedule({ cron: e.target.value })} placeholder='0 7 * * *' className={`${field} w-32 font-mono`} aria-label='Schedule' />
                )}
                {draft.schedule.freq === 'custom' && words && words !== cronExpr && <span className='text-[12px] text-text-muted'>{words}</span>}
              </>
            ) : routine?.kind === 'webhook' ? (
              <TriggerUrl token={routine.row.token} />
            ) : (
              <span className='text-[12px] text-text-muted'>its link appears once it exists</span>
            )}
          </div>

          <span className='text-text-muted'>Reports into</span>
          <select value={draft.conversation_id ?? ''} onChange={(e) => set({ conversation_id: e.target.value || null })} className={`${field} min-w-0 max-w-full justify-self-start`} aria-label='Reports into'>
            <option value=''>This thread only</option>
            {sorted.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>

          <span className='text-text-muted'>Notifies</span>
          {draft.conversation_id ? (
            <span className='text-[12.5px] text-text-secondary'>through that chat</span>
          ) : (
            <select value={draft.notify} onChange={(e) => set({ notify: e.target.value as Notify })} className={`${field} justify-self-start`} aria-label='Notifications'>
              {NOTIFY_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          )}
        </div>

        {/* What it is asked, drawn like the message it is: sent on every run. */}
        <div className='mt-4 px-4'>
          <div className='mb-1.5 text-[11.5px] text-text-muted'>Each run, Jarvis is asked</div>
          <div className='rounded-2xl rounded-br-md bg-accent-subtle px-3.5 py-2.5'>
            <AutoTextarea
              value={draft.prompt}
              onChange={(v) => set({ prompt: v })}
              placeholder='e.g. Check the Guincho forecast and tell me if it’s worth going — wind offshore, swell over 1.2 m.'
            />
          </div>
          <div className='mt-1.5 flex justify-end'>
            <ModelSelector model={draft.model} effort={draft.effort} onModelChange={(m) => set({ model: m })} onEffortChange={(e) => set({ effort: e })} direction='down' />
          </div>
        </div>

        {/* Actions. */}
        <div className='mt-2 flex items-center gap-2 border-t border-border/70 px-4 py-2.5'>
          {routine ? (
            <>
              <button type='button' onClick={fire} className='inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] text-text-secondary hover:bg-surface2 hover:text-accent transition-colors'>
                <Zap size={13} /> Run now
              </button>
              <CardMenu onDelete={remove} />
            </>
          ) : (
            <button type='button' onClick={discard} className='rounded-lg px-2 py-1 text-[12.5px] text-text-muted hover:bg-surface2 hover:text-text-primary transition-colors'>
              Discard
            </button>
          )}
          <span className='flex-1 text-right text-[12px] text-danger' role={error ? 'alert' : undefined}>{error}</span>
          {routine && dirty && (
            <button type='button' onClick={() => { setDraft(initial); setError('') }} className='rounded-lg px-2 py-1 text-[12.5px] text-text-muted hover:text-text-primary'>
              Revert
            </button>
          )}
          {(isNew || dirty) && (
            <button
              type='button'
              onClick={submit}
              disabled={busy}
              className='inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-accent-hover disabled:opacity-60 transition-colors'
            >
              {busy && <Loader2 size={12} className='animate-spin' />}
              {isNew ? 'Create routine' : 'Save'}
            </button>
          )}
          {routine && !dirty && <span className='inline-flex items-center gap-1 text-[12px] text-text-muted'><Check size={12} /> Up to date</span>}
        </div>
      </div>
      {!compact && isNew && (
        <p className='mt-2 text-center text-[12px] text-text-muted'>Fill it in — or just tell Jarvis below what you want it to do.</p>
      )}
    </div>
  )
}

/**
 * Quick access from the title bar: the routine's state at a glance, opening to
 * the same card — for when the top of a long thread isn't on screen.
 */
export function RoutineChip({ routine, thread, onChanged, defaultOpen }: {
  routine: Routine
  thread: Conversation
  onChanged: () => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  // The title bar exists twice (phone and desktop, one hidden): only the chip
  // actually on screen opens itself.
  useEffect(() => {
    if (defaultOpen && btnRef.current?.offsetParent) setOpen(true)
  }, [defaultOpen])
  const r = routine.row
  const when = routine.kind === 'cron' ? describeSchedule(routine.row.schedule) : 'when called'
  return (
    <>
      <button
        ref={btnRef}
        type='button'
        onClick={() => setOpen((o) => !o)}
        title='The routine'
        data-testid='routine-chip'
        className={`inline-flex max-w-[220px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${open ? 'border-accent/40 bg-surface2 text-text-primary' : 'border-border text-text-secondary hover:bg-surface2'}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.enabled ? 'bg-success' : 'bg-border'}`} />
        <span className='truncate'>{when}{r.enabled ? '' : ' · paused'}</span>
      </button>
      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} className='w-[min(460px,calc(100vw-24px))] rounded-2xl border border-border bg-surface shadow-xl'>
        <RoutineCard routine={routine} thread={thread} onChanged={onChanged} compact />
      </Popover>
    </>
  )
}

function CardMenu({ onDelete }: { onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={ref} type='button' onClick={() => setOpen((o) => !o)} aria-label='More' className='rounded-lg p-1 text-text-muted hover:bg-surface2 hover:text-text-primary transition-colors'>
        <MoreHorizontal size={14} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} placement='bottom-start' className='min-w-[170px] rounded-xl border border-border bg-surface p-1 shadow-md/5'>
        <button type='button' onClick={() => { setOpen(false); onDelete() }} className='flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-danger hover:bg-surface2'>
          <Trash2 size={14} /> Delete routine
        </button>
      </Popover>
    </>
  )
}

export function Switch({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      role='switch'
      aria-checked={on}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-success' : 'bg-border'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  )
}

/** Grows with its text, like the composer. */
function AutoTextarea({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={2}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label='Prompt'
      className='block w-full resize-none bg-transparent text-[14px] leading-relaxed text-text-primary placeholder:text-text-muted focus:outline-none'
    />
  )
}

function TriggerUrl({ token }: { token: string }) {
  const [copied, setCopied] = useState(false)
  const url = webhookUrl(token)
  return (
    <span className='flex min-w-0 flex-1 items-center gap-2'>
      <code className='min-w-0 flex-1 truncate rounded-lg border border-border bg-bg px-2 py-1 text-[11.5px] text-text-secondary'>{url}</code>
      <button
        type='button'
        onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
        title='Copy the link'
        className='shrink-0 text-text-muted hover:text-text-primary'
      >
        {copied ? <Check size={13} className='text-success' /> : <Copy size={13} />}
      </button>
    </span>
  )
}
