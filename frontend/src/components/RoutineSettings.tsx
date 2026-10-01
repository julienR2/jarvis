import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronDown, Clock, Copy, Link2, MessageSquare, Pencil, Trash2, Zap } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api, type Conversation } from '../api'
import { useChatStore } from '../stores/chatStore'
import { describeSchedule } from '../lib/runs'
import {
  draftOf,
  draftProblem,
  NOTIFY_OPTIONS,
  updateRoutine,
  webhookUrl,
  type Notify,
  type Routine,
  type RoutineSettingsDraft,
} from '../lib/routines'

const field = 'bg-surface2 border border-border text-text-primary rounded-lg px-3 py-1.5 text-sm focus:border-accent focus:outline-none w-full'

/**
 * A routine's settings — everything but its prompt, which is written in the
 * thread's own composer. Shared by a new routine and by the panel at the top
 * of an existing one's thread.
 */
export function RoutineFields({
  draft,
  onChange,
  isNew,
  token,
}: {
  draft: RoutineSettingsDraft
  onChange: (d: RoutineSettingsDraft) => void
  /** The trigger can only be chosen before it exists. */
  isNew?: boolean
  /** A webhook's token, for its link. */
  token?: string
}) {
  const conversations = useChatStore(useShallow((s) => s.order.map((id) => s.conversations[id]).filter(Boolean)))
  const sections = useChatStore(useShallow((s) => s.sections))
  // Threads are not offered: a routine reports into a chat.
  const chats = useMemo(
    () => conversations.filter((c) => c.kind !== 'thread').sort((a, b) => a.title.localeCompare(b.title)),
    [conversations],
  )
  const topicOf = (sectionId: string | null) => sections.find((s) => s.id === sectionId)?.name
  const isCron = draft.kind === 'cron'
  const words = isCron && draft.schedule.trim() ? describeSchedule(draft.schedule.trim()) : ''
  const set = (patch: Partial<RoutineSettingsDraft>) => onChange({ ...draft, ...patch })

  return (
    <div className='flex flex-col gap-3' data-testid='routine-fields'>
      {isNew && (
        <div className='flex rounded-lg border border-border bg-bg p-0.5 w-fit' role='radiogroup' aria-label='Trigger'>
          {([['cron', 'On a schedule', Clock], ['webhook', 'When called', Link2]] as const).map(([k, label, Icon]) => (
            <button
              key={k}
              type='button'
              role='radio'
              aria-checked={draft.kind === k}
              onClick={() => set({ kind: k })}
              className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-md transition-colors ${
                draft.kind === k ? 'bg-surface text-text-primary shadow-sm font-medium' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>
      )}

      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        <Field label='Name'>
          <input placeholder='e.g. morning-brief' value={draft.name} onChange={(e) => set({ name: e.target.value })} className={field} aria-label='Name' />
        </Field>
        {isCron ? (
          <Field label='Schedule' hint={words && words !== draft.schedule.trim() ? words : 'cron expression, in your timezone'}>
            <input placeholder='0 7 * * *' value={draft.schedule} onChange={(e) => set({ schedule: e.target.value })} className={`${field} font-mono`} aria-label='Schedule' />
          </Field>
        ) : token ? (
          <TriggerUrl token={token} />
        ) : (
          <Field label='Its link' hint='Given once it exists. Anything that can POST runs it; a JSON body is handed to the prompt.'>
            <div className={`${field} text-text-muted`}>—</div>
          </Field>
        )}
      </div>

      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        <Field
          label='Reports into'
          hint={draft.conversation_id ? 'Its answers land there — a quiet line when it had nothing to say.' : 'Shows in the sidebar’s Threads when a run is worth seeing.'}
        >
          <select value={draft.conversation_id ?? ''} onChange={(e) => set({ conversation_id: e.target.value || null })} className={field} aria-label='Reports into'>
            <option value=''>No chat — this thread</option>
            {chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}{topicOf(c.section_id) ? ` · ${topicOf(c.section_id)}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label='Notifications' hint={draft.conversation_id ? 'Set by the chat it reports into.' : undefined}>
          <select
            value={draft.conversation_id ? '' : draft.notify}
            disabled={!!draft.conversation_id}
            onChange={(e) => set({ notify: e.target.value as Notify })}
            className={`${field} disabled:opacity-50`}
            aria-label='Notifications'
          >
            {draft.conversation_id && <option value=''>From the chat</option>}
            {NOTIFY_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </Field>
      </div>
    </div>
  )
}

/**
 * The routine, at the top of its thread: one line saying when it runs and
 * where it reports, with the switch and Run now at hand; it opens to the
 * settings. The prompt is edited in the composer below (`onEditPrompt`).
 */
export function RoutinePanel({
  routine,
  thread,
  defaultOpen,
  editingPrompt,
  onEditPrompt,
  onChanged,
}: {
  routine: Routine
  thread: Conversation
  defaultOpen?: boolean
  editingPrompt: boolean
  onEditPrompt: () => void
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(!!defaultOpen)
  const [draft, setDraft] = useState(() => draftOf(routine, thread.notify))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setDraft(draftOf(routine, thread.notify)) }, [routine, thread.notify])
  useEffect(() => { if (defaultOpen) setOpen(true) }, [defaultOpen])

  const parent = useChatStore((s) => (routine.row.conversation_id ? s.conversations[routine.row.conversation_id] : undefined))
  const r = routine.row
  const Icon = routine.kind === 'webhook' ? Link2 : Clock
  const when = routine.kind === 'cron' ? describeSchedule(routine.row.schedule) : 'when called'
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(routine, thread.notify))

  async function save() {
    const problem = draftProblem(draft)
    if (problem) return setError(problem)
    setError('')
    setSaving(true)
    try {
      await updateRoutine(routine, {
        name: draft.name.trim(),
        ...(routine.kind === 'cron' ? { schedule: draft.schedule.trim() } : {}),
        conversation_id: draft.conversation_id,
        notify: draft.notify,
      })
      // The thread's name and notify mode follow, server-side.
      useChatStore.getState().loadConversations()
      onChanged()
      setOpen(false)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function toggle() {
    await updateRoutine(routine, { enabled: !r.enabled })
    onChanged()
  }

  async function fire() {
    if (routine.kind === 'cron') await api.triggerCron(r.id)
    else await api.triggerWebhook(r.id)
    window.__jarvisToast?.info(`${r.name} is running.`)
  }

  async function remove() {
    if (!window.confirm(`Delete the routine “${r.name}”? It stops running; this thread and what it wrote stay.`)) return
    if (routine.kind === 'cron') await api.deleteCron(r.id)
    else await api.deleteWebhook(r.id)
    useChatStore.getState().loadConversations()
    onChanged()
  }

  return (
    <div className='shrink-0 border-b border-border bg-bg-alt/60' data-testid='routine-panel'>
      <div className='max-w-3xl mx-auto px-4 md:px-6 py-2 flex items-center gap-2 text-[12px] text-text-muted'>
        <button
          type='button'
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className='flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-text-primary'
        >
          <Icon size={12} className='shrink-0' />
          <span className={`shrink-0 ${r.enabled ? 'text-text-secondary' : ''}`}>{when}</span>
          {!r.enabled && <span className='shrink-0'>· paused</span>}
          <span className='shrink-0'>·</span>
          <span className='truncate'>{parent ? `reports into ${parent.title}` : 'stands alone'}</span>
          <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        <button
          role='switch'
          aria-checked={!!r.enabled}
          aria-label={`${r.enabled ? 'Pause' : 'Resume'} ${r.name}`}
          onClick={toggle}
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${r.enabled ? 'bg-success' : 'bg-border'}`}
        >
          <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${r.enabled ? 'left-[14px]' : 'left-0.5'}`} />
        </button>
        <button type='button' onClick={fire} title='Run now' className='rounded-md p-1 hover:bg-surface2 hover:text-accent transition-colors'>
          <Zap size={13} />
        </button>
      </div>

      {open && (
        <div className='max-w-3xl mx-auto px-4 md:px-6 pb-4 pt-1 flex flex-col gap-3'>
          <div className='rounded-xl border border-border bg-surface px-3 py-2'>
            <div className='mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-text-muted'>
              <span>Each run is sent</span>
              {!editingPrompt && (
                <button type='button' onClick={onEditPrompt} className='inline-flex items-center gap-1 normal-case tracking-normal text-text-muted hover:text-text-primary'>
                  <Pencil size={11} /> Edit in the composer
                </button>
              )}
            </div>
            <div className='whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary line-clamp-6'>{r.prompt}</div>
          </div>
          <RoutineFields draft={draft} onChange={setDraft} token={routine.kind === 'webhook' ? routine.row.token : undefined} />
          {error && <div className='text-xs text-danger'>{error}</div>}
          <div className='flex items-center gap-2'>
            <button type='button' onClick={remove} className='inline-flex items-center gap-1 text-xs text-text-muted hover:text-danger transition-colors'>
              <Trash2 size={12} /> Delete routine
            </button>
            {parent && (
              <button type='button' onClick={() => navigate(`/c/${parent.id}`)} className='inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors'>
                <MessageSquare size={12} /> Open {parent.title}
              </button>
            )}
            <span className='flex-1' />
            <button type='button' onClick={() => { setDraft(draftOf(routine, thread.notify)); setOpen(false); setError('') }} className='px-3 py-1.5 text-xs text-text-muted hover:text-text-primary'>
              {dirty ? 'Cancel' : 'Close'}
            </button>
            {dirty && (
              <button type='button' onClick={save} disabled={saving} className='rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50'>
                Save
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * A div, not a label: the controls inside carry their own aria-label, and a
 * wrapping <label> would rename every button in it after the whole caption.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-1 min-w-0'>
      <span className='text-[11px] font-medium uppercase tracking-wide text-text-muted'>{label}</span>
      {children}
      {hint && <span className='text-[11px] text-text-muted'>{hint}</span>}
    </div>
  )
}

function TriggerUrl({ token }: { token: string }) {
  const [copied, setCopied] = useState(false)
  const url = webhookUrl(token)
  function copy() {
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Field label='Its link' hint='No login needed: the token is the secret. POST, optionally with a JSON body.'>
      <div className='flex items-center gap-2'>
        <code className='min-w-0 flex-1 truncate rounded-lg bg-bg px-3 py-1.5 text-xs text-text-secondary border border-border'>{url}</code>
        <button type='button' onClick={copy} title='Copy the link' className='shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:border-accent'>
          {copied ? <Check size={13} className='text-success' /> : <Copy size={13} />}
        </button>
      </div>
    </Field>
  )
}
