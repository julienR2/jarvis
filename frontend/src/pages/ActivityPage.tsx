import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Check, Clock, Copy, Link2, Loader2, MessageCircleQuestion, MessageSquare, Plus, RotateCcw, Settings2, Square, Trash2, Zap,
} from 'lucide-react'
import { CronForm, WebhookForm, Drawer } from '../components/RoutineForm'
import ContentLayout from '../components/ContentLayout'
import StatusPill from '../components/StatusPill'
import { api, describePending, pendingQuestionOf, type Cron, type RunListItem, type Webhook } from '../api'
import { describeSchedule, firstLine, formatTime, groupByDay, relative, useRunsNudge } from '../lib/runs'
import { useChatStore } from '../stores/chatStore'
import { useShallow } from 'zustand/react/shallow'

/**
 * What Jarvis did on his own, and what he is doing now.
 *
 * Log: every cron and webhook fire, newest first, grouped by day — with the one
 * paragraph it produced, where it wrote, and the actions that matter for its
 * state (Stop while running, Retry when it failed, the chat, the definition).
 * Routines: the crons and webhooks themselves, in one list, because to the
 * person reading they are the same thing — something that runs without them.
 *
 * Live through the global `runs` nudge: a run starting or ending anywhere
 * refetches whatever is on screen.
 */
type Filter = 'all' | 'running' | 'failed' | 'cron' | 'webhook'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'failed', label: 'Failed' },
  { id: 'cron', label: 'Crons' },
  { id: 'webhook', label: 'Webhooks' },
]

export default function ActivityPage() {
  // The tab lives in the URL so the old /crons and /webhooks addresses, and a
  // run card's gear, can land straight on Routines with a form open.
  const [params, setParams] = useSearchParams()
  const tab: 'log' | 'routines' = params.get('tab') === 'routines' ? 'routines' : 'log'
  const setTab = (t: 'log' | 'routines') =>
    setParams((p) => { if (t === 'log') p.delete('tab'); else p.set('tab', t); return p }, { replace: true })
  const openRoutine = (id: string) =>
    setParams((p) => { p.set('tab', 'routines'); p.set('edit', id); return p })

  return (
    <ContentLayout title='Activity'>
      <div className='max-w-3xl mx-auto px-4 md:px-6 py-4'>
        <div className='flex gap-1 border-b border-border mb-4' role='tablist'>
          {(['log', 'routines'] as const).map((t) => (
            <button
              key={t}
              role='tab'
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors ${
                tab === t ? 'border-text-primary text-text-primary font-medium' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              {t === 'log' ? 'Log' : 'Routines'}
            </button>
          ))}
        </div>
        {tab === 'log' ? <RunLog onOpenRoutine={openRoutine} /> : <Routines />}
      </div>
    </ContentLayout>
  )
}

// ── Log ──────────────────────────────────────────────────────────────────────

function RunLog({ onOpenRoutine }: { onOpenRoutine: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [sectionId, setSectionId] = useState<string>('')
  const [runs, setRuns] = useState<RunListItem[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const sections = useChatStore(useShallow((s) => s.sections))
  const navigate = useNavigate()

  const PAGE = 40
  const query = useCallback(
    (before?: string) =>
      api.listRunsAll({
        // A run parked on a question is still running, from where you sit.
        status: filter === 'running' ? ['running', 'needs_you'] : filter === 'failed' ? ['error'] : undefined,
        kind: filter === 'cron' || filter === 'webhook' ? filter : undefined,
        sectionId: sectionId || undefined,
        before,
        limit: PAGE,
      }),
    [filter, sectionId],
  )

  const load = useCallback(async () => {
    try {
      const rows = await query()
      setRuns(rows)
      setHasMore(rows.length === PAGE)
      setLoadError(false)
    } catch {
      // A failed fetch is not an empty log — say so, or a backend blip reads
      // as "nothing ever ran".
      setLoadError(true)
    }
  }, [query])

  // A run starting or ending anywhere refetches the page.
  useRunsNudge(load)

  async function loadMore() {
    if (!runs?.length) return
    const last = runs[runs.length - 1]
    const more = await query(`${last.started_at}:${last.seq}`)
    setRuns([...runs, ...more])
    setHasMore(more.length === PAGE)
  }

  async function act(run: RunListItem, what: 'stop' | 'retry') {
    setBusy((b) => ({ ...b, [run.id]: true }))
    try {
      if (what === 'stop') await api.stopRun(run.id)
      else await api.retryRun(run.id)
      await load()
    } finally {
      setBusy((b) => ({ ...b, [run.id]: false }))
    }
  }

  const days = useMemo(() => groupByDay(runs ?? []), [runs])

  return (
    <div>
      <div className='flex flex-wrap items-center gap-1.5 mb-3' role='group' aria-label='Filters'>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              filter === f.id ? 'bg-text-primary text-bg border-text-primary' : 'border-border text-text-secondary hover:bg-surface2'
            }`}
          >
            {f.label}
          </button>
        ))}
        {sections.length > 0 && (
          <select
            value={sectionId}
            onChange={(e) => setSectionId(e.target.value)}
            aria-label='Section'
            className='ml-auto rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-text-secondary'
          >
            <option value=''>Every section</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            <option value='none'>Chats outside sections</option>
          </select>
        )}
      </div>

      {loadError && runs === null ? (
        <div className='py-10 text-center text-sm text-text-muted'>Couldn't load the log. <button onClick={() => load()} className='underline hover:text-text-primary'>Try again</button></div>
      ) : runs === null ? (
        <div className='flex items-center gap-2 py-8 text-sm text-text-muted'><Loader2 size={14} className='animate-spin' /> Loading…</div>
      ) : runs.length === 0 ? (
        <div className='py-10 text-center text-sm text-text-muted'>Nothing here yet — routines write their runs into this log as they happen.</div>
      ) : (
        days.map((day) => (
          <section key={`${day.label}-${day.runs[0].id}`} className='mb-5'>
            <h2 className='text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1.5'>{day.label}</h2>
            <div className='rounded-xl border border-border bg-surface divide-y divide-border'>
              {day.runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  busy={!!busy[run.id]}
                  onStop={() => act(run, 'stop')}
                  onRetry={() => act(run, 'retry')}
                  onOpen={() => navigate(`/c/${run.conversation_id}`)}
                  onSettings={() => run.source_id && onOpenRoutine(run.source_id)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {hasMore && (
        <div className='flex justify-center py-2'>
          <button onClick={loadMore} className='text-xs text-text-muted hover:text-text-primary transition-colors'>Older runs</button>
        </div>
      )}
    </div>
  )
}

function RunRow({
  run, busy, onStop, onRetry, onOpen, onSettings,
}: {
  run: RunListItem
  busy: boolean
  onStop: () => void
  onRetry: () => void
  onOpen: () => void
  onSettings: () => void
}) {
  const Icon = run.kind === 'webhook' ? Link2 : Clock
  // A waiting run's one line is the question itself, read off its conversation.
  // Select the stored string, not the parsed object: a fresh object per read
  // would re-render this row without end.
  const pendingRaw = useChatStore((s) => (run.status === 'needs_you' ? s.conversations[run.conversation_id]?.pending_question ?? null : null))
  const pending = useMemo(() => pendingQuestionOf({ pending_question: pendingRaw }), [pendingRaw])
  const summary = run.status === 'error' ? run.error : pending ? describePending(pending) : run.result
  return (
    <div className='flex items-start gap-3 px-3 py-2.5' data-testid='run-row' data-status={run.status}>
      <div className='mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface2 text-text-muted'>
        <Icon size={13} />
      </div>
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
          <span className='truncate text-sm font-medium text-text-primary'>{run.source_name}</span>
          <StatusPill run={run} />
        </div>
        {summary && (
          <div className={`mt-0.5 text-[13px] leading-snug line-clamp-2 ${run.status === 'error' ? 'text-danger' : run.status === 'needs_you' ? 'text-text-primary' : 'text-text-secondary'}`}>
            {firstLine(summary)}
          </div>
        )}
        <div className='mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-text-muted'>
          <span>{formatTime(run.started_at)}</span>
          {run.conversation_title && (
            <>
              <span>·</span>
              <button onClick={onOpen} className='inline-flex items-center gap-1 hover:text-text-primary transition-colors'>
                <MessageSquare size={10} /> {run.conversation_title}
              </button>
            </>
          )}
        </div>
      </div>
      <div className='flex shrink-0 items-center gap-1'>
        {run.status === 'needs_you' && (
          <button onClick={onOpen} title='Answer in the chat' className='flex items-center gap-1 rounded-md border border-warning/50 px-2 py-1 text-[11px] font-medium text-warning hover:bg-warning/10'>
            <MessageCircleQuestion size={10} /> Answer
          </button>
        )}
        {(run.status === 'running' || run.status === 'needs_you') && (
          <button onClick={onStop} disabled={busy} title='Stop this run' className='flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-muted hover:bg-surface2 hover:text-danger disabled:opacity-40'>
            <Square size={10} fill='currentColor' /> Stop
          </button>
        )}
        {run.status === 'error' && run.kind === 'cron' && run.source_id && (
          <button onClick={onRetry} disabled={busy} title='Fire this cron again' className='flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-muted hover:bg-surface2 hover:text-text-primary disabled:opacity-40'>
            <RotateCcw size={10} /> Retry
          </button>
        )}
        {run.source_id && (
          <button onClick={onSettings} title={`Open this ${run.kind}'s settings`} className='rounded-md p-1 text-text-muted/60 hover:bg-surface2 hover:text-text-primary'>
            <Settings2 size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Routines ─────────────────────────────────────────────────────────────────

type Routine =
  | { kind: 'cron'; row: Cron }
  | { kind: 'webhook'; row: Webhook }

function Routines() {
  const [items, setItems] = useState<Routine[] | null>(null)
  const [drawer, setDrawer] = useState<{ kind: 'cron' | 'webhook'; item?: Cron | Webhook } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const filterConvId = params.get('conversation_id')
  const conversations = useChatStore((s) => s.conversations)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    const [crons, hooks] = await Promise.all([api.getCrons(), api.getWebhooks()])
    const all: Routine[] = [
      ...crons.map((row): Routine => ({ kind: 'cron', row })),
      ...hooks.map((row): Routine => ({ kind: 'webhook', row })),
    ]
    all.sort((a, b) => a.row.name.localeCompare(b.row.name))
    setItems(all)
  }, [])

  useEffect(() => {
    load().catch(() => setItems([]))
  }, [load])

  // ?edit=<id>: open that routine's form — how a run card's gear and the old
  // /crons?edit= links land here. Consumed once, or saving would reopen it.
  useEffect(() => {
    const id = params.get('edit')
    if (!id || !items) return
    const target = items.find((r) => r.row.id === id)
    if (target) setDrawer({ kind: target.kind, item: target.row })
    setParams((p) => { p.delete('edit'); return p }, { replace: true })
  }, [items, params, setParams])

  async function toggle(r: Routine) {
    if (r.kind === 'cron') await api.updateCron(r.row.id, { enabled: !r.row.enabled })
    else await api.updateWebhook(r.row.id, { enabled: !r.row.enabled })
    await load()
  }
  async function fire(r: Routine) {
    if (r.kind === 'cron') await api.triggerCron(r.row.id)
    else await api.triggerWebhook(r.row.id)
  }
  async function remove(r: Routine) {
    if (!window.confirm(`Delete ${r.kind} “${r.row.name}”? Its past runs stay in the log.`)) return
    if (r.kind === 'cron') await api.deleteCron(r.row.id)
    else await api.deleteWebhook(r.row.id)
    await load()
  }
  function copyUrl(token: string) {
    navigator.clipboard.writeText(`${window.location.origin}/api/hooks/${token}/trigger`)
    setCopied(token)
    setTimeout(() => setCopied(null), 2000)
  }

  const displayed = (items ?? []).filter((r) => !filterConvId || r.row.conversation_id === filterConvId)

  return (
    <div>
      <div className='flex flex-wrap items-center gap-2 mb-3'>
        {filterConvId && (
          <span className='flex items-center gap-2 text-xs text-text-muted'>
            Routines of one chat
            <button onClick={() => setParams((p) => { p.delete('conversation_id'); return p })} className='text-accent hover:opacity-80'>Show all</button>
          </span>
        )}
        <span className='flex-1' />
        <button onClick={() => setDrawer({ kind: 'cron' })} className='flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-text-secondary hover:bg-surface2'>
          <Plus size={12} /> New cron
        </button>
        <button onClick={() => setDrawer({ kind: 'webhook' })} className='flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-text-secondary hover:bg-surface2'>
          <Plus size={12} /> New webhook
        </button>
      </div>

      {items === null ? (
        <div className='flex items-center gap-2 py-8 text-sm text-text-muted'><Loader2 size={14} className='animate-spin' /> Loading…</div>
      ) : displayed.length === 0 ? (
        <div className='py-10 text-center text-sm text-text-muted'>No routines yet. A cron runs on a schedule; a webhook runs when something calls it.</div>
      ) : (
        <div className='rounded-xl border border-border bg-surface divide-y divide-border'>
          {displayed.map((r) => {
            const Icon = r.kind === 'webhook' ? Link2 : Clock
            const conv = r.row.conversation_id ? conversations[r.row.conversation_id] : undefined
            const when = r.kind === 'cron' ? describeSchedule(r.row.schedule) : 'when called'
            return (
              <div key={`${r.kind}-${r.row.id}`} className={`flex items-start gap-3 px-3 py-2.5 ${r.row.enabled ? '' : 'opacity-70'}`} data-testid='routine-row'>
                <div className='mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface2 text-text-muted'><Icon size={13} /></div>
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-x-2'>
                    <span className='truncate text-sm font-medium text-text-primary'>{r.row.name}</span>
                    <span className='text-[11px] text-text-muted'>{when}</span>
                    {!r.row.enabled && <span className='rounded-full border border-border px-1.5 text-[10.5px] text-text-muted'>off</span>}
                  </div>
                  <div className='mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-text-muted'>
                    {r.row.last_run ? <span>last {relative(r.row.last_run)}</span> : <span>never ran</span>}
                    {conv && (
                      <>
                        <span>·</span>
                        <button onClick={() => navigate(`/c/${conv.id}`)} className='inline-flex items-center gap-1 hover:text-text-primary transition-colors'>
                          <MessageSquare size={10} /> {conv.title}
                        </button>
                      </>
                    )}
                  </div>
                  {r.row.last_result && (
                    <div className='mt-0.5 text-[12.5px] text-text-secondary line-clamp-1'>{firstLine(r.row.last_result)}</div>
                  )}
                </div>
                <div className='flex shrink-0 items-center gap-0.5'>
                  <button
                    role='switch'
                    aria-checked={!!r.row.enabled}
                    aria-label={`${r.row.enabled ? 'Disable' : 'Enable'} ${r.row.name}`}
                    onClick={() => toggle(r)}
                    className={`relative mr-1 h-5 w-9 rounded-full transition-colors ${r.row.enabled ? 'bg-success' : 'bg-border'}`}
                  >
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${r.row.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                  <button onClick={() => fire(r)} title='Fire now' className='rounded-md p-1 text-text-muted/60 hover:bg-surface2 hover:text-accent'><Zap size={13} /></button>
                  {r.kind === 'webhook' && (
                    <button onClick={() => copyUrl(r.row.token)} title={copied === r.row.token ? 'Copied!' : 'Copy trigger URL'} className={`rounded-md p-1 hover:bg-surface2 ${copied === r.row.token ? 'text-success' : 'text-text-muted/60 hover:text-text-primary'}`}>
                      {copied === r.row.token ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  )}
                  <button onClick={() => setDrawer({ kind: r.kind, item: r.row })} title={`Edit this ${r.kind}`} className='rounded-md p-1 text-text-muted/60 hover:bg-surface2 hover:text-text-primary'><Settings2 size={13} /></button>
                  <button onClick={() => remove(r)} title={`Delete this ${r.kind}`} className='rounded-md p-1 text-text-muted/60 hover:bg-surface2 hover:text-danger'><Trash2 size={13} /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {drawer && (
        <Drawer title={drawer.kind === 'cron' ? 'Cron' : 'Webhook'} onClose={() => setDrawer(null)}>
          {drawer.kind === 'cron' ? (
            <CronForm initial={drawer.item as Cron | undefined} onSaved={() => { setDrawer(null); load() }} onCancel={() => setDrawer(null)} />
          ) : (
            <WebhookForm initial={drawer.item as Webhook | undefined} onSaved={() => { setDrawer(null); load() }} onCancel={() => setDrawer(null)} />
          )}
        </Drawer>
      )}
    </div>
  )
}
