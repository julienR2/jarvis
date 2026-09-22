import { useEffect, useMemo, useState } from 'react'
import { Check, Clock, Copy, Link2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { api, type Cron, type CronInput, type Webhook, type WebhookInput } from '../api'
import ModelSelector, { getDefaultModel, DEFAULT_EFFORT } from './ModelSelector'
import { useChatStore } from '../stores/chatStore'
import { describeSchedule } from '../lib/runs'

/**
 * A routine is a saved prompt Jarvis runs without you: on a schedule, or when
 * something calls its link. Under the hood those are still two rows (a cron, a
 * webhook) — to the person filling this in they are one thing with one
 * question up front, "when does it run?", so one form.
 *
 * Defaults, and why:
 * - "Use chat memory" is off. A routine's prompt is self-contained, and
 *   inheriting the chat means re-reading (and paying for) its whole history on
 *   every fire.
 * - The model is pinned to a concrete id, not left null: a routine keeps
 *   running on the model it was set up with, a cheap one for a routine task,
 *   while the chat it posts into follows whatever you talk to it with.
 * - The destination is the chat it was created from when there is one, else a
 *   chat Jarvis opens on the first run.
 */
export type Routine =
  | { kind: 'cron'; row: Cron }
  | { kind: 'webhook'; row: Webhook }

export type RoutineKind = Routine['kind']

const field = 'bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent w-full'
const check = 'flex gap-1.5 items-center cursor-pointer text-text-muted'

interface Draft {
  kind: RoutineKind
  name: string
  schedule: string
  once: boolean
  prompt: string
  enabled: boolean
  inherit_context: boolean
  solo: boolean
  model: string
  effort: CronInput['effort']
  conversation_id: string | null
}

function emptyDraft(kind: RoutineKind, conversationId: string | null): Draft {
  return {
    kind, name: '', schedule: '', once: false, prompt: '', enabled: true, inherit_context: false, solo: false,
    model: getDefaultModel(), effort: DEFAULT_EFFORT, conversation_id: conversationId,
  }
}

function fromRoutine(r: Routine): Draft {
  return {
    kind: r.kind,
    name: r.row.name,
    schedule: r.kind === 'cron' ? r.row.schedule : '',
    once: r.kind === 'cron' ? !!r.row.once : false,
    prompt: r.row.prompt,
    enabled: !!r.row.enabled,
    inherit_context: !!r.row.inherit_context,
    solo: r.kind === 'cron' ? !!r.row.solo : false,
    model: r.row.model ?? getDefaultModel(),
    effort: r.row.effort ?? DEFAULT_EFFORT,
    conversation_id: r.row.conversation_id,
  }
}

export function RoutineForm({
  initial,
  kind = 'cron',
  conversationId = null,
  onSaved,
  onCancel,
}: {
  initial?: Routine
  /** Trigger to start a new routine with. Fixed once it exists. */
  kind?: RoutineKind
  /** The chat a new routine posts into; null = a chat opened on the first run. */
  conversationId?: string | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [form, setForm] = useState<Draft>(() => (initial ? fromRoutine(initial) : emptyDraft(kind, conversationId)))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setForm(initial ? fromRoutine(initial) : emptyDraft(kind, conversationId))
  }, [initial, kind, conversationId])

  const conversations = useChatStore(useShallow((s) => s.order.map((id) => s.conversations[id]).filter(Boolean)))
  const sections = useChatStore(useShallow((s) => s.sections))
  const sorted = useMemo(
    () => [...conversations].sort((a, b) => a.title.localeCompare(b.title)),
    [conversations],
  )
  const topicOf = (sectionId: string | null) => sections.find((s) => s.id === sectionId)?.name

  const isCron = form.kind === 'cron'
  const scheduleWords = isCron && form.schedule.trim() ? describeSchedule(form.schedule.trim()) : ''
  const canSave = !!form.name.trim() && !!form.prompt.trim() && (!isCron || !!form.schedule.trim())

  async function save() {
    setError('')
    setSaving(true)
    try {
      const common = {
        name: form.name.trim(),
        prompt: form.prompt,
        enabled: form.enabled,
        inherit_context: form.inherit_context,
        model: form.model,
        effort: form.effort,
        conversation_id: form.conversation_id,
      }
      if (isCron) {
        const body: CronInput = { ...common, schedule: form.schedule.trim(), once: form.once, solo: form.solo }
        if (initial) await api.updateCron(initial.row.id, body)
        else await api.createCron(body)
      } else {
        const body: WebhookInput = common
        if (initial) await api.updateWebhook(initial.row.id, body)
        else await api.createWebhook(body)
      }
      onSaved()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='flex flex-col gap-4' data-testid='routine-form'>
      <h3 className='font-medium text-sm'>{initial ? 'Edit routine' : 'New routine'}</h3>
      {error && <div className='text-danger text-xs'>{error}</div>}

      {/* Trigger — the one question that makes it a cron or a webhook. */}
      <Field label='Runs'>
        {initial ? (
          <div className='flex items-center gap-2 text-sm text-text-secondary'>
            {isCron ? <Clock size={13} /> : <Link2 size={13} />}
            {isCron ? 'on a schedule' : 'when its link is called'}
          </div>
        ) : (
          <div className='flex rounded-lg border border-border bg-bg p-0.5 w-fit' role='radiogroup' aria-label='Trigger'>
            {([['cron', 'On a schedule', Clock], ['webhook', 'When called', Link2]] as const).map(([k, label, Icon]) => (
              <button
                key={k}
                type='button'
                role='radio'
                aria-checked={form.kind === k}
                onClick={() => setForm({ ...form, kind: k })}
                className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-md transition-colors ${
                  form.kind === k ? 'bg-surface text-text-primary shadow-sm font-medium' : 'text-text-muted hover:text-text-primary'
                }`}
              >
                <Icon size={12} /> {label}
              </button>
            ))}
          </div>
        )}
      </Field>

      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        <Field label='Name'>
          <input placeholder='e.g. morning-brief' value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} aria-label='Name' />
        </Field>
        {isCron && (
          <Field label='Schedule' hint={scheduleWords && scheduleWords !== form.schedule.trim() ? scheduleWords : 'cron expression, in your timezone'}>
            <input placeholder='0 7 * * *' value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} className={`${field} font-mono`} aria-label='Schedule' />
          </Field>
        )}
      </div>

      <Field label='What Jarvis does'>
        <textarea placeholder='The prompt it runs with — write it as you would ask in a chat.' value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={5} className={`${field} resize-y`} aria-label='Prompt' />
      </Field>

      <Field label='Posts into' hint='Where each run writes its result.'>
        <select
          value={form.conversation_id ?? ''}
          onChange={(e) => setForm({ ...form, conversation_id: e.target.value || null })}
          className={field}
          aria-label='Posts into'
        >
          <option value=''>A new chat, opened on the first run</option>
          {sorted.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}{topicOf(c.section_id) ? ` · ${topicOf(c.section_id)}` : ''}
            </option>
          ))}
        </select>
      </Field>

      <div className='flex flex-wrap gap-x-4 gap-y-2 items-center text-sm'>
        <label className={check}><input type='checkbox' checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className='accent-accent' /> Enabled</label>
        {isCron && (
          <label className={check} title='Fires once, then deletes itself — a reminder.'>
            <input type='checkbox' checked={form.once} onChange={(e) => setForm({ ...form, once: e.target.checked })} className='accent-accent' /> Run once
          </label>
        )}
        {isCron && (
          <label className={check} title='Skips a fire while any routine is still running or waiting for you — for a worker that must not compete with live work.'>
            <input type='checkbox' checked={form.solo} onChange={(e) => setForm({ ...form, solo: e.target.checked })} className='accent-accent' /> Only when idle
          </label>
        )}
        <label className={check} title="Off: each run starts fresh and only posts its result into the chat — cheaper, and it leaves the chat's own memory untouched. On: the run reads everything said in the chat.">
          <input type='checkbox' checked={form.inherit_context} onChange={(e) => setForm({ ...form, inherit_context: e.target.checked })} className='accent-accent' /> Use chat memory
        </label>
        <ModelSelector model={form.model} effort={form.effort ?? DEFAULT_EFFORT} onModelChange={(m) => setForm({ ...form, model: m })} onEffortChange={(e) => setForm({ ...form, effort: e })} direction='down' />
      </div>

      {initial?.kind === 'webhook' && <TriggerUrl token={initial.row.token} />}
      {!initial && !isCron && (
        <p className='text-xs text-text-muted'>
          Once created, the routine gets a link. Anything that can send a <span className='font-mono text-text-primary'>POST</span> — n8n, a mail filter, a script — runs it; an optional JSON body is handed to the prompt.
        </p>
      )}

      <div className='flex gap-2 items-center justify-end pt-1'>
        <button onClick={onCancel} className='text-text-muted px-3 py-2 text-sm hover:text-text-primary transition-colors'>Cancel</button>
        <button onClick={save} disabled={!canSave || saving} className='bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors'>
          {initial ? 'Save' : 'Create'}
        </button>
      </div>
    </div>
  )
}

/**
 * A div, not a label: the controls inside carry their own aria-label, and a
 * wrapping <label> would rename every button in it after the whole caption.
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-1'>
      <span className='text-[11px] font-medium uppercase tracking-wide text-text-muted'>{label}</span>
      {children}
      {hint && <span className='text-[11px] text-text-muted'>{hint}</span>}
    </div>
  )
}

/** The public URL a webhook routine answers to, with copy. The token is the secret. */
export function webhookUrl(token: string): string {
  return `${window.location.origin}/api/hooks/${token}/trigger`
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
    <Field label='Its link' hint='No login needed: the token in the address is the secret. Send a POST, optionally with a JSON body.'>
      <div className='flex items-center gap-2'>
        <code className='min-w-0 flex-1 truncate rounded-lg bg-bg px-3 py-2 text-xs text-text-secondary border border-border'>{url}</code>
        <button type='button' onClick={copy} title='Copy the link' className='shrink-0 rounded-lg border border-border px-2.5 py-2 text-xs text-text-secondary hover:border-accent'>
          {copied ? <Check size={13} className='text-success' /> : <Copy size={13} />}
        </button>
      </div>
    </Field>
  )
}

/** A side panel on desktop, a sheet on mobile — where a routine is edited. */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className='fixed inset-0 z-[300] flex justify-end bg-black/30' onClick={onClose} role='dialog' aria-label={title}>
      <div
        onClick={(e) => e.stopPropagation()}
        className='h-full w-full sm:w-[520px] max-w-full overflow-y-auto bg-surface border-l border-border shadow-xl p-5 animate-fade-in'
      >
        <div className='flex items-center justify-between mb-4'>
          <span className='text-xs uppercase tracking-wide text-text-muted font-semibold'>{title}</span>
          <button onClick={onClose} title='Close' className='rounded-md p-1 text-text-muted hover:bg-surface2 hover:text-text-primary'><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
