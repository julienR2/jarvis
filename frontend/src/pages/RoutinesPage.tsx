import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Check, Clock, Copy, Link2, Loader2, MessageSquare, Plus, Settings2, Trash2, X, Zap } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import ContentLayout from '../components/ContentLayout'
import { Drawer, RoutineForm, webhookUrl, type Routine, type RoutineKind } from '../components/RoutineForm'
import { api } from '../api'
import { describeSchedule, firstLine, relative } from '../lib/runs'
import { useChatStore } from '../stores/chatStore'

/**
 * Every routine Jarvis runs without you, in one list — the crons and the
 * webhooks, because to the person reading they are the same thing: a saved
 * prompt, a trigger, a chat it posts into.
 *
 * What the routines DID is not here. A run is not content; the message it
 * produced is, and that lives in the chat it posted into, with Today holding
 * the day's inbox. This page is where a routine is created, paused, fired by
 * hand, edited or deleted — the low-traffic page a routine needs in order to
 * outlive its chat.
 *
 * Filtered to one chat (`?conversation_id=`) or one topic (`?section_id=`)
 * when reached from there; `?edit=<id>` opens a routine, `?new=cron|webhook`
 * a blank form, both consumed once.
 */
export default function RoutinesPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [items, setItems] = useState<Routine[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [drawer, setDrawer] = useState<{ kind: RoutineKind; item?: Routine; conversationId?: string | null } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const conversations = useChatStore((s) => s.conversations)
  const sections = useChatStore(useShallow((s) => s.sections))

  const filterConvId = params.get('conversation_id')
  const filterSectionId = params.get('section_id')

  const load = useCallback(async () => {
    try {
      const [crons, hooks] = await Promise.all([api.getCrons(), api.getWebhooks()])
      const all: Routine[] = [
        ...crons.map((row): Routine => ({ kind: 'cron', row })),
        ...hooks.map((row): Routine => ({ kind: 'webhook', row })),
      ]
      all.sort((a, b) => a.row.name.localeCompare(b.row.name))
      setItems(all)
      setLoadError(false)
    } catch {
      setLoadError(true)
      setItems((prev) => prev ?? [])
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ?edit=<id> and ?new=<kind> open the drawer once — consumed, or saving would reopen it.
  useEffect(() => {
    const editId = params.get('edit')
    const newKind = params.get('new')
    if (!items) return
    if (editId) {
      const target = items.find((r) => r.row.id === editId)
      if (target) setDrawer({ kind: target.kind, item: target })
      setParams((p) => { p.delete('edit'); return p }, { replace: true })
    } else if (newKind === 'cron' || newKind === 'webhook') {
      setDrawer({ kind: newKind, conversationId: filterConvId })
      setParams((p) => { p.delete('new'); return p }, { replace: true })
    }
  }, [items, params, setParams, filterConvId])

  async function toggle(r: Routine) {
    if (r.kind === 'cron') await api.updateCron(r.row.id, { enabled: !r.row.enabled })
    else await api.updateWebhook(r.row.id, { enabled: !r.row.enabled })
    await load()
  }
  async function fire(r: Routine) {
    if (r.kind === 'cron') await api.triggerCron(r.row.id)
    else await api.triggerWebhook(r.row.id)
    window.__jarvisToast?.info(`${r.row.name} is running${r.row.conversation_id ? ' — its chat shows the result' : ''}.`)
  }
  async function remove(r: Routine) {
    if (!window.confirm(`Delete the routine “${r.row.name}”? What it already posted stays in its chat.`)) return
    if (r.kind === 'cron') await api.deleteCron(r.row.id)
    else await api.deleteWebhook(r.row.id)
    await load()
  }
  function copyUrl(token: string) {
    navigator.clipboard.writeText(webhookUrl(token))
    setCopied(token)
    setTimeout(() => setCopied(null), 2000)
  }

  const displayed = useMemo(
    () => (items ?? []).filter((r) => {
      if (filterConvId) return r.row.conversation_id === filterConvId
      if (filterSectionId) return !!r.row.conversation_id && conversations[r.row.conversation_id]?.section_id === filterSectionId
      return true
    }),
    [items, filterConvId, filterSectionId, conversations],
  )
  const active = (items ?? []).filter((r) => r.row.enabled).length
  const paused = (items ?? []).length - active
  const filterLabel = filterConvId
    ? conversations[filterConvId]?.title ?? 'one chat'
    : filterSectionId
      ? sections.find((s) => s.id === filterSectionId)?.name ?? 'one topic'
      : null

  return (
    <ContentLayout title={
      <span className='flex items-center gap-2'>
        Routines
        {items && items.length > 0 && (
          <span className='text-xs font-normal text-text-muted'>
            {active} active{paused > 0 ? ` · ${paused} paused` : ''}
          </span>
        )}
      </span>
    }>
      <div className='flex flex-wrap items-center gap-2 mb-4'>
        {filterLabel && (
          <button
            onClick={() => setParams((p) => { p.delete('conversation_id'); p.delete('section_id'); return p })}
            className='inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-text-secondary hover:bg-surface2'
            title='Show every routine'
          >
            {filterConvId ? <MessageSquare size={11} /> : null}
            {filterLabel}
            <X size={11} />
          </button>
        )}
        <span className='flex-1' />
        <button
          onClick={() => setDrawer({ kind: 'cron', conversationId: filterConvId })}
          className='inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors'
        >
          <Plus size={13} /> New routine
        </button>
      </div>

      {items === null ? (
        <div className='flex items-center gap-2 py-8 text-sm text-text-muted'><Loader2 size={14} className='animate-spin' /> Loading…</div>
      ) : loadError && items.length === 0 ? (
        <div className='py-10 text-center text-sm text-text-muted'>Couldn't load the routines. <button onClick={load} className='underline hover:text-text-primary'>Try again</button></div>
      ) : displayed.length === 0 ? (
        <div className='py-12 text-center text-sm text-text-muted'>
          {filterLabel ? 'No routine posts here yet.' : 'No routines yet.'}
          <div className='mt-1 text-xs'>A routine is a prompt Jarvis runs without you — every morning, or whenever something calls its link. Ask for one in any chat, or create it here.</div>
        </div>
      ) : (
        <div className='divide-y divide-border'>
          {displayed.map((r) => {
            const Icon = r.kind === 'webhook' ? Link2 : Clock
            const conv = r.row.conversation_id ? conversations[r.row.conversation_id] : undefined
            const when = r.kind === 'cron' ? describeSchedule(r.row.schedule) : 'when called'
            const topic = conv?.section_id ? sections.find((s) => s.id === conv.section_id)?.name : undefined
            return (
              <div key={`${r.kind}-${r.row.id}`} className={`group flex items-start gap-3 py-3 ${r.row.enabled ? '' : 'opacity-60'}`} data-testid='routine-row'>
                <span className='mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface2 text-text-muted'><Icon size={13} /></span>
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-baseline gap-x-2'>
                    <span className='truncate text-sm font-medium text-text-primary'>{r.row.name}</span>
                    <span className='text-[12px] text-text-secondary'>{when}</span>
                    {!r.row.enabled && <span className='text-[11px] text-text-muted'>paused</span>}
                  </div>
                  <div className='mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-text-muted'>
                    {conv ? (
                      <button onClick={() => navigate(`/c/${conv.id}`)} className='inline-flex items-center gap-1 hover:text-text-primary transition-colors'>
                        <MessageSquare size={10} /> {conv.title}{topic ? <span className='opacity-70'>· {topic}</span> : null}
                      </button>
                    ) : (
                      <span>opens a chat when it runs</span>
                    )}
                    <span>·</span>
                    <span>{r.row.last_run ? `last ${relative(r.row.last_run)}` : 'never ran'}</span>
                  </div>
                  {r.row.last_result && (
                    <div className='mt-0.5 text-[12.5px] text-text-secondary line-clamp-1'>{firstLine(r.row.last_result)}</div>
                  )}
                </div>
                <div className='flex shrink-0 items-center gap-0.5'>
                  <button
                    role='switch'
                    aria-checked={!!r.row.enabled}
                    aria-label={`${r.row.enabled ? 'Pause' : 'Resume'} ${r.row.name}`}
                    onClick={() => toggle(r)}
                    className={`relative mr-1.5 h-5 w-9 rounded-full transition-colors ${r.row.enabled ? 'bg-success' : 'bg-border'}`}
                  >
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${r.row.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                  <IconButton title='Run now' onClick={() => fire(r)} hover='hover:text-accent'><Zap size={13} /></IconButton>
                  {r.kind === 'webhook' && (
                    <IconButton title={copied === r.row.token ? 'Copied!' : 'Copy its link'} onClick={() => copyUrl(r.row.token)} className={copied === r.row.token ? 'text-success' : ''}>
                      {copied === r.row.token ? <Check size={13} /> : <Copy size={13} />}
                    </IconButton>
                  )}
                  <IconButton title='Edit this routine' onClick={() => setDrawer({ kind: r.kind, item: r })}><Settings2 size={13} /></IconButton>
                  <IconButton title='Delete this routine' onClick={() => remove(r)} hover='hover:text-danger'><Trash2 size={13} /></IconButton>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {drawer && (
        <Drawer title='Routine' onClose={() => setDrawer(null)}>
          <RoutineForm
            initial={drawer.item}
            kind={drawer.kind}
            conversationId={drawer.conversationId ?? null}
            onSaved={() => { setDrawer(null); load() }}
            onCancel={() => setDrawer(null)}
          />
        </Drawer>
      )}
    </ContentLayout>
  )
}

function IconButton({ title, onClick, children, hover = 'hover:text-text-primary', className = '' }: {
  title: string
  onClick: () => void
  children: React.ReactNode
  hover?: string
  className?: string
}) {
  return (
    <button onClick={onClick} title={title} className={`rounded-md p-1 text-text-muted/60 hover:bg-surface2 ${hover} ${className}`}>
      {children}
    </button>
  )
}
