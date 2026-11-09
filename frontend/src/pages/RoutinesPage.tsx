import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertCircle, Check, ChevronRight, Clock, Copy, Link2, Loader2, MessageCircleQuestion, MessageSquare, MoreHorizontal, Plus, Settings2, Square, Trash2, X, Zap } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { SidebarToggle } from '../components/ContentLayout'
import NeedsYouCard from '../components/NeedsYouCard'
import Popover from '../components/Popover'
import { Switch } from '../components/RoutineCard'
import { listRoutines, routinePath, webhookUrl, type Routine } from '../lib/routines'
import { api, pendingQuestionOf, type Conversation, type RunListItem } from '../api'
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
 * Laid out as a topic's page is: its title bar with the way to make one, a
 * plain-words line on what routines are where a topic has its brief, the
 * routines waiting for you, then the list.
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

  // Routines waiting for an answer: the chats their waiting runs are in (the
  // routine's own, or the chat it runs in), each once, with its question.
  const [waitingIds, setWaitingIds] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    const load = () => api.listRunsAll({ status: ['needs_you'], limit: 50 })
      .then((runs) => alive && setWaitingIds([...new Set(runs.map((r) => r.conversation_id))]))
      .catch(() => {})
    load()
    window.addEventListener(RUNS_NUDGE_EVENT, load)
    return () => { alive = false; window.removeEventListener(RUNS_NUDGE_EVENT, load) }
  }, [])
  const waiting = waitingIds
    .map((id) => conversations[id])
    .filter((c): c is Conversation => !!c && !!pendingQuestionOf(c)
      && (!filterConvId || c.id === filterConvId || c.parent_id === filterConvId)
      && (!filterSectionId || (c.section_id ?? (c.parent_id ? conversations[c.parent_id]?.section_id : null)) === filterSectionId))

  return (
    <div className='flex flex-col h-full' data-testid='routines-page'>
      <div className='shrink-0 border-b border-border'>
        <div className='flex items-center gap-2 h-12 px-3 md:px-6'>
          <SidebarToggle />
          <h1 className='min-w-0 flex-1 truncate text-sm font-medium text-text-primary'>
            Routines
            {items && items.length > 0 && (
              <span className='ml-2 text-xs font-normal text-text-muted'>
                {active} active{paused > 0 ? ` · ${paused} paused` : ''}
              </span>
            )}
          </h1>
          <button
            onClick={() => navigate(newRoutinePath('cron', filterConvId))}
            className='inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-text-secondary hover:bg-surface2 hover:text-text-primary transition-colors'
          >
            <Plus size={13} /> New routine
          </button>
        </div>
      </div>

      <div className='flex-1 overflow-y-auto'>
        <div className='max-w-3xl mx-auto px-4 md:px-6 py-6 flex flex-col gap-7'>
          <section className='rounded-xl bg-surface2/70 px-4 py-3 text-[13.5px] leading-relaxed text-text-secondary' data-testid='routines-intro'>
            <strong className='font-semibold text-text-primary'>What Jarvis does on its own.</strong>{' '}
            A routine runs by itself — on a schedule (every morning, every hour…) or when something arrives (an email
            forwarded to it, a link being called). Each has its own chat where every run happens, and can post what it
            finds into one of your chats. Ask for one in any chat, or press New routine.
          </section>

          {filterLabel && (
            <div>
              <button
                onClick={() => setParams((p) => { p.delete('conversation_id'); p.delete('section_id'); return p })}
                className='inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-text-secondary hover:bg-surface2'
                title='Show every routine'
              >
                {filterConvId ? <MessageSquare size={11} /> : null}
                {filterLabel}
                <X size={11} />
              </button>
            </div>
          )}

          {waiting.length > 0 && (
            <section data-testid='routines-waiting'>
              <Eyebrow>Needs you · {waiting.length}</Eyebrow>
              <div className='flex flex-col gap-3'>
                {waiting.map((c) => (
                  <NeedsYouCard key={c.id} conversation={c} onOpen={() => navigate(`/c/${c.id}`)} />
                ))}
              </div>
            </section>
          )}

          <section data-testid='routines-list'>
            <Eyebrow>Routines{displayed.length ? ` · ${displayed.length}` : ''}</Eyebrow>
      {items === null ? (
        <div className='flex items-center gap-2 py-3 text-xs text-text-muted'><Loader2 size={12} className='animate-spin' /> Loading…</div>
      ) : loadError && items.length === 0 ? (
        <div className='py-3 text-[12.5px] text-text-muted'>Couldn't load the routines. <button onClick={load} className='underline hover:text-text-primary'>Try again</button></div>
      ) : displayed.length === 0 ? (
        <p className='py-2 text-[12.5px] text-text-muted'>
          {filterLabel ? 'No routine posts here yet.' : 'No routine yet.'} Ask for one in any chat — “check the surf every morning and tell me when it’s good” — or press New routine.
        </p>
      ) : (
        <div className='divide-y divide-border'>
          {displayed.map((r) => {
            const Icon = r.kind === 'webhook' ? Link2 : Clock
            const conv = r.row.conversation_id ? conversations[r.row.conversation_id] : undefined
            const when = r.kind === 'cron' ? describeSchedule(r.row.schedule) : 'when called'
            const topic = conv?.section_id ? sections.find((s) => s.id === conv.section_id)?.name : undefined
            return (
              // The row is the way into the routine's thread; what sits on it
              // (its chat, its runs, the menu, the switch) keeps its own click.
              <div
                key={`${r.kind}-${r.row.id}`}
                onClick={() => navigate(routinePath(r, false))}
                className='group -mx-2 flex cursor-pointer items-start gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-surface2/60'
                data-testid='routine-row'
              >
                <div className={`flex min-w-0 flex-1 items-start gap-3 ${r.row.enabled ? '' : 'opacity-60'}`}>
                <span className='mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface2 text-text-muted'><Icon size={13} /></span>
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-baseline gap-x-2'>
                    <span className='truncate text-sm font-medium text-text-primary'>{r.row.name}</span>
                    <span className='text-[12px] text-text-secondary'>{when}</span>
                    {!r.row.enabled && <span className='text-[11px] text-text-muted'>paused</span>}
                  </div>
                  <div className='mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-text-muted'>
                    {conv ? (
                      <button onClick={(e) => { e.stopPropagation(); navigate(`/c/${conv.id}`) }} className='inline-flex items-center gap-1 hover:text-text-primary transition-colors' title='The chat it reports into'>
                        <MessageSquare size={10} /> {conv.title}{topic ? <span className='opacity-70'>· {topic}</span> : null}
                      </button>
                    ) : (
                      <span>its own chat</span>
                    )}
                    <span>·</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setExpanded((x) => ({ ...x, [r.row.id]: !x[r.row.id] })) }}
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
                </div>
                {/* The switch last, so it lines up down the list whatever the menu holds. */}
                <div className='flex shrink-0 items-center gap-1' onClick={(e) => e.stopPropagation()}>
                  <RowMenu
                    routine={r}
                    copied={r.kind === 'webhook' && copied === r.row.token}
                    onRun={() => fire(r)}
                    onCopy={r.kind === 'webhook' ? () => copyUrl(r.row.token) : undefined}
                    onSettings={() => navigate(routinePath(r))}
                    onDelete={() => remove(r)}
                  />
                  <Switch on={!!r.row.enabled} label={`${r.row.enabled ? 'Pause' : 'Resume'} ${r.row.name}`} onClick={() => toggle(r)} />
                </div>
              </div>
            )
          })}
        </div>
      )}
          </section>
        </div>
      </div>
    </div>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <h2 className='mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted'>{children}</h2>
}

function newRoutinePath(kind: 'cron' | 'webhook', conversationId: string | null): string {
  return `/routines/new?kind=${kind}${conversationId ? `&conversation_id=${conversationId}` : ''}`
}

/** The rarer actions on a routine, behind ⋯. */
function RowMenu({ routine, copied, onRun, onCopy, onSettings, onDelete }: {
  routine: Routine
  copied: boolean
  onRun: () => void
  onCopy?: () => void
  onSettings: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const item = 'w-full flex items-center gap-2.5 px-2 py-1.5 text-sm rounded-lg hover:bg-surface2 transition-colors text-text-secondary'
  const pick = (fn: () => void) => () => { setOpen(false); fn() }
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        title='More'
        aria-label={`More for ${routine.row.name}`}
        className={`rounded-md p-1 text-text-muted/70 transition-colors hover:bg-surface2 hover:text-text-primary ${open ? 'bg-surface2 text-text-primary' : ''}`}
      >
        <MoreHorizontal size={15} />
      </button>
      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} className='min-w-[170px] bg-surface border border-border rounded-xl shadow-md/5 p-1'>
        <button className={item} onClick={pick(onRun)}><Zap size={14} /> Run now</button>
        {onCopy && <button className={item} onClick={pick(onCopy)}>{copied ? <Check size={14} /> : <Copy size={14} />} Copy its link</button>}
        <button className={item} onClick={pick(onSettings)}><Settings2 size={14} /> Settings</button>
        <button className={`${item} !text-danger`} onClick={pick(onDelete)}><Trash2 size={14} /> Delete</button>
      </Popover>
    </>
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
          onClick={(e) => { e.stopPropagation(); navigate(`/c/${run.conversation_id}?run=${run.id}`) }}
          title='Open its chat at this run'
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
