import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api, type Cron, type CronInput, type Webhook, type WebhookInput } from '../api'
import ModelSelector, { getDefaultModel, DEFAULT_EFFORT } from './ModelSelector'

/**
 * The cron and webhook forms, as they were on their own pages, now opened
 * from Activity › Routines. Same fields, same defaults, same reasons:
 *
 * - "Use conversation context" is off by default. A routine's prompt is
 *   self-contained, so inheriting the conversation only means re-reading its
 *   whole history — and paying for it — on every fire.
 * - The model is pinned to a concrete id, not left null: a routine keeps
 *   running on the model it was set up with, a cheap one for a routine task,
 *   while the chat it posts into follows whatever you talk to it with.
 */

const field = 'bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent'
const check = 'flex gap-1.5 items-center cursor-pointer text-text-muted'

function emptyCron(): CronInput {
  return { name: '', schedule: '', prompt: '', enabled: true, once: false, inherit_context: false, model: getDefaultModel(), effort: DEFAULT_EFFORT }
}
function emptyWebhook(): WebhookInput {
  return { name: '', prompt: '', enabled: true, inherit_context: false, model: getDefaultModel(), effort: DEFAULT_EFFORT }
}

export function CronForm({ initial, onSaved, onCancel }: { initial?: Cron; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<CronInput>(emptyCron)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!initial) return
    setForm({
      name: initial.name, schedule: initial.schedule, prompt: initial.prompt,
      enabled: !!initial.enabled, once: !!initial.once, inherit_context: !!initial.inherit_context,
      model: initial.model ?? getDefaultModel(), effort: initial.effort ?? DEFAULT_EFFORT,
    })
  }, [initial])

  async function save() {
    setError('')
    try {
      if (initial) await api.updateCron(initial.id, form)
      else await api.createCron(form)
      onSaved()
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <div className='flex flex-col gap-3' data-testid='cron-form'>
      <h3 className='font-medium text-sm'>{initial ? 'Edit cron' : 'New cron'}</h3>
      {error && <div className='text-danger text-xs'>{error}</div>}
      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        <input placeholder='Name (e.g. daily-brief)' value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} />
        <input placeholder='Schedule (e.g. 0 7 * * *)' value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} className={`${field} font-mono`} />
      </div>
      <textarea placeholder='Prompt sent to the agent' value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={4} className={`${field} resize-y`} />
      <div className='flex flex-wrap gap-4 items-center text-sm'>
        <label className={check}><input type='checkbox' checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className='accent-accent' /> Enabled</label>
        <label className={check}><input type='checkbox' checked={form.once} onChange={(e) => setForm({ ...form, once: e.target.checked })} className='accent-accent' /> Run once</label>
        <label className={check} title="Off: each run starts fresh and only posts its result here — cheaper, and it leaves the conversation's own session untouched. On: the run inherits everything said in the conversation.">
          <input type='checkbox' checked={form.inherit_context ?? false} onChange={(e) => setForm({ ...form, inherit_context: e.target.checked })} className='accent-accent' /> Use conversation context
        </label>
        <ModelSelector model={form.model ?? getDefaultModel()} effort={form.effort ?? DEFAULT_EFFORT} onModelChange={(m) => setForm({ ...form, model: m })} onEffortChange={(e) => setForm({ ...form, effort: e })} direction='down' />
      </div>
      <div className='flex gap-2 items-center justify-end pt-1'>
        <button onClick={onCancel} className='text-text-muted px-3 py-2 text-sm hover:text-text-primary transition-colors'>Cancel</button>
        <button onClick={save} disabled={!form.name || !form.schedule || !form.prompt} className='bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors'>
          {initial ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  )
}

export function WebhookForm({ initial, onSaved, onCancel }: { initial?: Webhook; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<WebhookInput>(emptyWebhook)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!initial) return
    setForm({
      name: initial.name, prompt: initial.prompt, enabled: !!initial.enabled,
      inherit_context: !!initial.inherit_context, model: initial.model ?? getDefaultModel(), effort: initial.effort ?? DEFAULT_EFFORT,
    })
  }, [initial])

  async function save() {
    setError('')
    try {
      if (initial) await api.updateWebhook(initial.id, form)
      else await api.createWebhook(form)
      onSaved()
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <div className='flex flex-col gap-3' data-testid='webhook-form'>
      <h3 className='font-medium text-sm'>{initial ? 'Edit webhook' : 'New webhook'}</h3>
      {error && <div className='text-danger text-xs'>{error}</div>}
      <input placeholder='Name (e.g. email-processor)' value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} />
      <textarea placeholder='Prompt sent to the agent when triggered' value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={4} className={`${field} resize-y`} />
      <div className='flex flex-wrap gap-4 items-center text-sm'>
        <label className={check}><input type='checkbox' checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className='accent-accent' /> Enabled</label>
        <label className={check} title="Off: each trigger starts fresh and only posts its result here — cheaper, and it leaves the conversation's own session untouched. On: the run inherits everything said in the conversation.">
          <input type='checkbox' checked={form.inherit_context ?? false} onChange={(e) => setForm({ ...form, inherit_context: e.target.checked })} className='accent-accent' /> Use conversation context
        </label>
        <ModelSelector model={form.model ?? getDefaultModel()} effort={form.effort ?? DEFAULT_EFFORT} onModelChange={(m) => setForm({ ...form, model: m })} onEffortChange={(e) => setForm({ ...form, effort: e })} direction='down' />
      </div>
      <details className='text-xs text-text-muted'>
        <summary className='cursor-pointer select-none'>How to trigger it</summary>
        <p className='mt-2 mb-2'>
          Send a <span className='font-mono text-text-primary'>POST</span> to the webhook URL (Copy URL on its row). The JSON body is optional and is appended to the prompt as context. No authentication: the token in the URL is the secret.
        </p>
        <pre className='bg-bg rounded-lg p-3 overflow-x-auto text-text-secondary font-mono leading-relaxed'>{`curl -X POST <webhook-url> \\
  -H "Content-Type: application/json" \\
  -d '{ "from": "alice@example.com", "subject": "Meeting tomorrow" }'`}</pre>
      </details>
      <div className='flex gap-2 items-center justify-end pt-1'>
        <button onClick={onCancel} className='text-text-muted px-3 py-2 text-sm hover:text-text-primary transition-colors'>Cancel</button>
        <button onClick={save} disabled={!form.name || !form.prompt} className='bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors'>
          {initial ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  )
}

/** A side panel on desktop, a sheet on mobile — the form's home inside Activity. */
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
