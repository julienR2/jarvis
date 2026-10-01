import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertCircle, Check, ChevronRight, Clock, Copy, Link2, Loader2, MessageCircleQuestion, MessageSquare, Hash, Plus, Settings2, Square, Trash2, X, Zap } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import ContentLayout from '../components/ContentLayout'
import { listRoutines, routinePath, webhookUrl, type Routine } from '../lib/routines'
import { api, type RunListItem } from '../api'
import { describeSchedule, firstLine, relative, RUNS_NUDGE_EVENT } from '../lib/runs'
import { useChatStore } from '../stores/chatStore'

/**
 * Every routine Jarvis runs without you, in one list — the crons and the
 * webhooks, because to the person reading they are the same thing: a saved
 * prompt, a trigger, a thread it runs in, maybe a chat it reports into.
 *
 * Each routine's runs open under it, each a way into its thread at that run:
 * the thread is the record, this page is the index. It is also where a
 * routine is paused, fired by hand or deleted. Creating and editing one happen
 * in its thread: a routine is a thread that runs by itself.
 *
 * Filtered to one chat (`?conversation_id=`) or one topic (`?section_id=`)
 * when reached from there. The old `?edit=<id>` and `?new=cron|webhook`
 * addresses still land: on the routine's thread, or on a new routine.
 */
export default function RoutinesPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const [items, setItems] = useState<Routine[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const conversations = useChatStore((s) => s.conversations)
  const sections = useChatStore(useShallow((s) => s.sections))

  const filterConvId = params.get('conversation_id')
  const filterSectionId = params.get('section_id')

  const load = useCallback(async () => {
    try {
      setItems(await listRoutines())
      setLoadError(false)
    } catch {
      setLoadError(true)
      setItems((prev) => prev ?? [])
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ?edit=<id> → the routine's thread; ?new=<kind> → a new routine.
  useEffect(() => {
    const editId = params.get('edit')
    const newKind = params.get('new')
    if (newKind === 'cron' || newKind === 'webhook') {
      navigate(newRoutinePath(newKind, filterConvId), { replace: true })
    } else if (editId && items) {
      const target = items.find((r) => r.row.id === editId)
      if (target) navigate(routinePath(target), { replace: true })
      else setParams((p) => { p.delete('edit'); return p }, { replace: true })
    }
  }, [items, params, setParams, filterConvId, navigate])

  async function toggle(r: Routine) {
    if (r.kind === 'cron') await api.updateCron(r.row.id, { enabled: !r.row.enabled })
    else await api.updateWebhook(r.row.id, { enabled: !r.row.enabled })
    await load()
  }
  async function fire(r: Routine) {
    if (r.kind === 'cron') await api.triggerCron(r.row.id)
    else await api.triggerWebhook(r.row.id)
    window.__jarvisToast?.info(`${r.row.name} is running — its runs below show it.`)
    setExpanded((e) => ({ ...e, [r.row.id]: true }))
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
      if (filterConvId) return r.row.conversation_id === filterConvId || r.row.thread_id === filterConvId
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
          onClick={() => navigate(newRoutinePath('cron', filterConvId))}
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
                      <button onClick={() => navigate(`/c/${conv.id}`)} className='inline-flex items-center gap-1 hover:text-text-primary transition-colors' title='The chat it reports into'>
                        <MessageSquare size={10} /> {conv.title}{topic ? <span className='opacity-70'>· {topic}</span> : null}
                      </button>
                    ) : (
                      <span>its own thread</span>
                    )}
                    <span>·</span>
                    <button
                      onClick={() => setExpanded((e) => ({ ...e, [r.row.id]: !e[r.row.id] }))}
                      className='inline-flex items-center gap-0.5 hover:text-text-primary transition-colors'
                      aria-expanded={!!expanded[r.row.id]}
                    >
                      <ChevronRight size={10} className={`transition-transform ${expanded[r.row.id] ? 'rotate-90' : ''}`} />
                      {r.row.last_run ? `last ran ${relative(r.row.last_run)}` : 'never ran'}
                    </button>
                  </div>
                  {r.row.last_result && !expanded[r.row.id] && (
                    <div className='mt-0.5 text-[12.5px] text-text-secondary line-clamp-1'>{firstLine(r.row.last_result)}</div>
                  )}
                  {expanded[r.row.id] && <RoutineRuns sourceId={r.row.id} />}
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
                  {r.row.thread_id && (
                    <IconButton title='Open its thread' onClick={() => navigate(`/c/${r.row.thread_id}`)}><Hash size={13} /></IconButton>
                  )}
                  {r.kind === 'webhook' && (
                    <IconButton title={copied === r.row.token ? 'Copied!' : 'Copy its link'} onClick={() => copyUrl(r.row.token)} className={copied === r.row.token ? 'text-success' : ''}>
                      {copied === r.row.token ? <Check size={13} /> : <Copy size={13} />}
                    </IconButton>
                  )}
                  <IconButton title='Edit this routine' onClick={() => navigate(routinePath(r))}><Settings2 size={13} /></IconButton>
                  <IconButton title='Delete this routine' onClick={() => remove(r)} hover='hover:text-danger'><Trash2 size={13} /></IconButton>
                </div>
              </div>
            )
          })}
        </div>
      )}

    </ContentLayout>
  )
}

function newRoutinePath(kind: 'cron' | 'webhook', conversationId: string | null): string {
  return `/routines/new?kind=${kind}${conversationId ? `&conversation_id=${conversationId}` : ''}`
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

/**
 * A routine's latest runs, newest first. A row opens the thread at that run;
 * kept fresh by the app-wide runs nudge, so a run fired from here shows up.
 */
function RoutineRuns({ sourceId }: { sourceId: string }) {
  const navigate = useNavigate()
  const [runs, setRuns] = useState<RunListItem[] | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => api.listRunsAll({ sourceId, limit: 15 }).then((r) => alive && setRuns(r)).catch(() => alive && setRuns((p) => p ?? []))
    load()
    window.addEventListener(RUNS_NUDGE_EVENT, load)
    return () => { alive = false; window.removeEventListener(RUNS_NUDGE_EVENT, load) }
  }, [sourceId])
  if (runs === null) return <div className='mt-2 flex items-center gap-1.5 text-[11.5px] text-text-muted'><Loader2 size={11} className='animate-spin' /> Loading runs…</div>
  if (runs.length === 0) return <div className='mt-2 text-[11.5px] text-text-muted'>No runs yet.</div>
  return (
    <div className='mt-2 flex flex-col border-l border-border pl-3' data-testid='routine-runs'>
      {runs.map((run) => (
        <button
          key={run.id}
          onClick={() => navigate(`/c/${run.conversation_id}?run=${run.id}`)}
          title='Open the thread at this run'
          className='flex min-w-0 items-center gap-2 rounded py-1 text-left text-[12px] text-text-secondary transition-colors hover:text-text-primary'
        >
          <RunStatusIcon run={run} />
          <span className='shrink-0 tabular-nums text-text-muted'>{relative(run.started_at)}</span>
          <span className={`truncate ${run.quiet ? 'text-text-muted' : ''}`}>
            {run.status === 'running' ? 'running…' : run.status === 'needs_you' ? 'waiting for you' : firstLine(run.error ?? run.result ?? '') || run.status}
          </span>
        </button>
      ))}
    </div>
  )
}

function RunStatusIcon({ run }: { run: RunListItem }) {
  switch (run.status) {
    case 'running':
      return <Loader2 size={11} className='shrink-0 animate-spin text-accent' />
    case 'needs_you':
      return <MessageCircleQuestion size={11} className='shrink-0 text-warning' />
    case 'error':
    case 'interrupted':
      return <AlertCircle size={11} className='shrink-0 text-danger' />
    case 'stopped':
      return <Square size={9} className='shrink-0 text-text-muted' />
    default:
      return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${run.quiet ? 'bg-border' : 'bg-success'}`} />
  }
}
