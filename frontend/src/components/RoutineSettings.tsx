import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronDown, Clock, Copy, Link2, MessageSquare, Sparkles, Trash2, X, Zap } from 'lucide-react'
import { api, type Conversation } from '../api'
import { useChatStore } from '../stores/chatStore'
import { describeSchedule } from '../lib/runs'
import { NOTIFY_OPTIONS, updateRoutine, webhookUrl, type Routine } from '../lib/routines'
import { modelName } from './ModelSelector'

/**
 * The routine, at the top of its thread: one line saying when it runs and
 * where it reports, with the switch and Run now at hand. It opens to what the
 * routine is — read-only: changing it is a conversation in this thread
 * ("Change something", or just saying so).
 */
export function RoutinePanel({
  routine,
  thread,
  defaultOpen,
  onChanged,
}: {
  routine: Routine
  thread: Conversation
  defaultOpen?: boolean
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(!!defaultOpen)
  useEffect(() => { if (defaultOpen) setOpen(true) }, [defaultOpen])

  const parent = useChatStore((s) => (routine.row.conversation_id ? s.conversations[routine.row.conversation_id] : undefined))
  const r = routine.row
  const Icon = routine.kind === 'webhook' ? Link2 : Clock
  const when = routine.kind === 'cron' ? describeSchedule(routine.row.schedule) : 'when called'
  const notifyLabel = NOTIFY_OPTIONS.find(([v]) => v === thread.notify)?.[1] ?? thread.notify

  async function toggle() {
    await updateRoutine(routine, { enabled: !r.enabled })
    onChanged()
  }

  async function fire() {
    if (routine.kind === 'cron') await api.triggerCron(r.id)
    else await api.triggerWebhook(r.id)
    window.__jarvisToast?.info(`${r.name} is running.`)
  }

  async function change() {
    setOpen(false)
    await api.startRoutineEdit(thread.id)
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
        <button type='button' onClick={fire} title='Run now' className='rounded-md p-1 hover:bg-surface2 hover:text-accent transition-colors'>
          <Zap size={13} />
        </button>
        <Switch on={!!r.enabled} label={`${r.enabled ? 'Pause' : 'Resume'} ${r.name}`} onClick={toggle} />
      </div>

      {open && (
        <div className='max-w-3xl mx-auto px-4 md:px-6 pb-4 pt-1 flex flex-col gap-3'>
          <div className='rounded-xl border border-border bg-surface px-3 py-2'>
            <div className='mb-1 text-[11px] font-medium uppercase tracking-wide text-text-muted'>Each run is sent</div>
            <div className='whitespace-pre-wrap text-[13px] leading-relaxed text-text-secondary line-clamp-6'>{r.prompt}</div>
          </div>
          <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]'>
            <dt className='text-text-muted'>Runs</dt>
            <dd className='text-text-secondary'>
              {when}
              {routine.kind === 'cron' && when !== routine.row.schedule && <span className='ml-2 font-mono text-[11px] text-text-muted'>{routine.row.schedule}</span>}
              {routine.kind === 'cron' && !!routine.row.once && <span className='ml-2 text-text-muted'>· once</span>}
            </dd>
            {routine.kind === 'webhook' && (
              <>
                <dt className='text-text-muted'>Its link</dt>
                <dd className='min-w-0'><TriggerUrl token={routine.row.token} /></dd>
              </>
            )}
            <dt className='text-text-muted'>Reports into</dt>
            <dd className='text-text-secondary'>{parent ? parent.title : 'nothing — this thread'}</dd>
            <dt className='text-text-muted'>Notifications</dt>
            <dd className='text-text-secondary'>{parent ? 'from the chat' : notifyLabel}</dd>
            <dt className='text-text-muted'>Model</dt>
            <dd className='text-text-secondary'>{r.model ? modelName(r.model) : 'the default'}</dd>
          </dl>
          <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
            <button type='button' onClick={change} className='inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors'>
              <Sparkles size={12} /> Change something
            </button>
            {parent && (
              <button type='button' onClick={() => navigate(`/c/${parent.id}`)} className='inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors'>
                <MessageSquare size={12} /> Open {parent.title}
              </button>
            )}
            <span className='flex-1' />
            <button type='button' onClick={remove} className='inline-flex items-center gap-1 text-xs text-text-muted hover:text-danger transition-colors'>
              <Trash2 size={12} /> Delete routine
            </button>
          </div>
          <p className='text-[11px] text-text-muted'>Or just say what to change, below.</p>
        </div>
      )}
    </div>
  )
}

/**
 * A thread opened to set up a routine, before the routine exists. Cancel
 * throws it away — nothing was made yet.
 */
export function RoutineDraftBar({ thread }: { thread: Conversation }) {
  const navigate = useNavigate()
  async function cancel() {
    await useChatStore.getState().deleteConversation(thread.id)
    navigate(thread.parent_id ? `/c/${thread.parent_id}` : '/routines', { replace: true })
  }
  return (
    <div className='shrink-0 border-b border-border bg-bg-alt/60' data-testid='routine-draft'>
      <div className='max-w-3xl mx-auto px-4 md:px-6 py-2 flex items-center gap-2 text-[12px] text-text-muted'>
        <Sparkles size={12} className='shrink-0' />
        <span className='flex-1'>Setting up a routine — answer below, or just describe it in your own words.</span>
        <button type='button' onClick={cancel} className='inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface2 hover:text-text-primary transition-colors'>
          <X size={12} /> Cancel
        </button>
      </div>
    </div>
  )
}

export function Switch({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      role='switch'
      aria-checked={on}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? 'bg-success' : 'bg-border'}`}
    >
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${on ? 'left-[14px]' : 'left-0.5'}`} />
    </button>
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
    <span className='flex min-w-0 items-center gap-2'>
      <code className='min-w-0 flex-1 truncate rounded bg-bg px-2 py-0.5 text-[11px] text-text-secondary border border-border'>{url}</code>
      <button type='button' onClick={copy} title='Copy the link' className='shrink-0 text-text-muted hover:text-text-primary'>
        {copied ? <Check size={12} className='text-success' /> : <Copy size={12} />}
      </button>
    </span>
  )
}
