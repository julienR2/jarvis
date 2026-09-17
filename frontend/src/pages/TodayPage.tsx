import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, Link2, MessageCircleQuestion, MessageSquare, RotateCcw, Settings2, Sparkles, Square } from 'lucide-react'
import ChatInput from '../components/ChatInput'
import StatusPill from '../components/StatusPill'
import NeedsYouCard from '../components/NeedsYouCard'
import { SidebarToggle } from '../components/ContentLayout'
import { api, pendingQuestionOf, type Attachment, type RunListItem, type UpcomingCron } from '../api'
import { useChatStore } from '../stores/chatStore'
import { firstLine, formatTime, reloadRecentRuns, startOfToday, upcomingLabel, useRecentRuns, useRunsNudge } from '../lib/runs'

/**
 * Home. A prompt first — the assistant is still the point — and under it what
 * Jarvis did without you today, in the order it matters: what failed and is
 * waiting on you, what is running now, what got done, what comes next.
 *
 * A quiet day shows the composer and nothing else: no empty boxes, no
 * padding. Every section appears only when it has something to say.
 */
export default function TodayPage() {
  const navigate = useNavigate()
  const conversations = useChatStore((s) => s.conversations)
  // Since yesterday: a run that started late last night and is still going
  // is "happening now", and a failure from last night still waits.
  const { runs, error: loadError } = useRecentRuns()
  const [upcoming, setUpcoming] = useState<UpcomingCron[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [starting, setStarting] = useState(false)

  // A run ending moves its cron's next fire, so the schedule follows the nudge too.
  const loadUpcoming = useCallback(
    () => api.getUpcomingCrons().then(setUpcoming).catch(() => {}),
    [],
  )
  useRunsNudge(loadUpcoming)
  const load = () => Promise.all([reloadRecentRuns(), loadUpcoming()])

  const { waiting, needsYou, running, doneToday } = useMemo(() => partition(runs ?? []), [runs])

  // Questions asked in an ordinary chat have no run behind them (they are not a
  // cron or webhook), so the runs feed never carries them. Read them straight
  // off the conversations: whatever is waiting on you, with no run of its own.
  const interactiveWaiting = useMemo(
    () => Object.values(conversations).filter((c) => {
      const q = pendingQuestionOf(c)
      return !!q && !q.run_id
    }),
    [conversations],
  )

  // A running row shows its elapsed time; keep it moving without a refetch.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (running.length === 0) return
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [running.length])

  // The composer opens a fresh chat with what was typed: the conversation is
  // created, the message sent, and the chat opened to watch the answer come.
  async function start(text: string, attachments: Attachment[]) {
    if (starting) return
    setStarting(true)
    try {
      const conv = await useChatStore.getState().createConversation()
      await api.sendMessage(conv.id, text, attachments)
      navigate(`/c/${conv.id}`)
    } catch (err) {
      console.error('Could not start the chat:', err)
      window.__jarvisToast?.error("Couldn't start the chat — try again.")
      setStarting(false)
    }
  }
  async function startWithAudio(blob: Blob) {
    if (starting) return
    setStarting(true)
    try {
      const conv = await useChatStore.getState().createConversation()
      await api.sendAudio(conv.id, blob)
      navigate(`/c/${conv.id}`)
    } catch (err) {
      console.error('Could not start the chat:', err)
      window.__jarvisToast?.error("Couldn't start the chat — try again.")
      setStarting(false)
    }
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

  const open = (conversationId: string | null) => conversationId && navigate(`/c/${conversationId}`)
  const openLabel = (conversationId: string | null) =>
    conversationId && conversations[conversationId]?.app_path ? 'Open app' : 'Open'
  const convTitle = (conversationId: string | null) =>
    conversationId ? conversations[conversationId]?.title : undefined

  const dateLine = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className='flex flex-col h-full'>
      <div className='shrink-0 border-b border-border'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1 min-h-12 px-3 md:px-6 py-2.5'>
          <SidebarToggle />
          <h1 className='text-sm font-medium text-text-primary'>Today</h1>
          <span className='text-xs text-text-muted'>{dateLine}</span>
          <span className='flex-1' />
          {running.length > 0 && (
            <span className='inline-flex items-center gap-1 rounded-full border border-accent/30 px-2 py-px text-[11px] text-accent' data-testid='today-running'>
              <span className='h-1.5 w-1.5 rounded-full bg-accent animate-pulse' />
              {running.length} running
            </span>
          )}
        </div>
      </div>

      <div className='flex-1 overflow-y-auto'>
        <div className='pt-3'>
          <ChatInput
            onSend={start}
            onSendAudio={startWithAudio}
            onCancel={() => {}}
            isProcessing={false}
            autoFocus
          />
        </div>

        <div className='max-w-3xl mx-auto px-4 md:px-6 pb-8'>
          {loadError && runs === null && (
            <div className='py-6 text-center text-sm text-text-muted'>
              Couldn't load today's activity. <button onClick={() => load()} className='underline hover:text-text-primary'>Try again</button>
            </div>
          )}

          {(interactiveWaiting.length > 0 || waiting.length > 0 || needsYou.length > 0) && (
            <section className='mt-5' data-testid='today-needs'>
              <h2 className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted'>
                Needs you<span className='font-normal'> · {interactiveWaiting.length + waiting.length + needsYou.length}</span>
              </h2>
              <div className='flex flex-col gap-3'>
                {/* Questions first — a decision to make, each its own little chat. */}
                {interactiveWaiting.map((conv) => (
                  <NeedsYouCard key={conv.id} conversation={conv} onOpen={() => open(conv.id)} />
                ))}
                {waiting.map((run) => {
                  const conv = conversations[run.conversation_id]
                  if (!conv) return null
                  return <NeedsYouCard key={run.id} conversation={conv} run={run} onOpen={() => open(run.conversation_id)} />
                })}
                {/* Then failures that need a fix — grouped, since they read as a list. */}
                {needsYou.length > 0 && (
                  <div className='rounded-xl border border-border bg-surface divide-y divide-border'>
                    {needsYou.map(({ run, attempts }) => (
                      <Row
                        key={run.id}
                        run={run}
                        summary={run.error}
                        tone='danger'
                        meta={[formatTime(run.started_at), attempts > 1 ? `${attempts} attempts` : null]}
                        chat={convTitle(run.conversation_id)}
                        onChat={() => open(run.conversation_id)}
                        actions={
                          <>
                            <ActionButton onClick={() => open(run.conversation_id)}>{openLabel(run.conversation_id)}</ActionButton>
                            {run.kind === 'cron' && run.source_id && (
                              <ActionButton primary disabled={!!busy[run.id]} onClick={() => act(run, 'retry')} title='Fire this cron again'>
                                <RotateCcw size={11} /> Retry
                              </ActionButton>
                            )}
                          </>
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
          {running.length > 0 && (
            <Section title='Happening now' testId='today-now'>
              {running.map((run) => (
                <Row
                  key={run.id}
                  run={run}
                  summary={run.result}
                  meta={[`since ${formatTime(run.started_at)}`, run.inherit_context ? null : 'isolated']}
                  chat={convTitle(run.conversation_id)}
                  onChat={() => open(run.conversation_id)}
                  actions={
                    <>
                      <ActionButton onClick={() => open(run.conversation_id)}>Watch</ActionButton>
                      <ActionButton danger disabled={!!busy[run.id]} onClick={() => act(run, 'stop')} title='Stop this run'>
                        <Square size={10} fill='currentColor' /> Stop
                      </ActionButton>
                    </>
                  }
                />
              ))}
            </Section>
          )}

          {doneToday.length > 0 && (
            <Section title='Done today' testId='today-done'>
              {doneToday.map((run) => (
                <Row
                  key={run.id}
                  run={run}
                  summary={run.status === 'done' ? run.result : run.error}
                  meta={[formatTime(run.started_at)]}
                  chat={convTitle(run.conversation_id)}
                  onChat={() => open(run.conversation_id)}
                  actions={<ActionButton onClick={() => open(run.conversation_id)}>{openLabel(run.conversation_id)}</ActionButton>}
                />
              ))}
            </Section>
          )}

          {upcoming.length > 0 && (
            <Section title='Coming up' testId='today-upcoming'>
              {upcoming.slice(0, UPCOMING_SHOWN).map((cron) => (
                <div key={cron.id} className='flex items-center gap-3 px-3 py-2' data-testid='today-row'>
                  <div className='grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface2 text-text-muted'><Clock size={13} /></div>
                  <div className='min-w-0 flex-1'>
                    <div className='flex flex-wrap items-center gap-x-2'>
                      <span className='truncate text-sm font-medium text-text-primary'>{cron.name}</span>
                      <span className='text-[12px] text-text-secondary'>{cron.next_run ? upcomingLabel(cron.next_run) : 'not scheduled'}</span>
                    </div>
                    {convTitle(cron.conversation_id) && (
                      <button onClick={() => open(cron.conversation_id)} className='mt-0.5 inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary transition-colors'>
                        <MessageSquare size={10} /> {convTitle(cron.conversation_id)}
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => navigate(`/activity?tab=routines&edit=${cron.id}`)}
                    title="Open this cron's settings"
                    className='rounded-md p-1 text-text-muted/60 hover:bg-surface2 hover:text-text-primary'
                  >
                    <Settings2 size={13} />
                  </button>
                </div>
              ))}
              {upcoming.length > UPCOMING_SHOWN && (
                <button onClick={() => navigate('/activity?tab=routines')} className='w-full px-3 py-2 text-left text-[12px] text-text-muted hover:text-text-primary'>
                  {upcoming.length - UPCOMING_SHOWN} more in Routines
                </button>
              )}
            </Section>
          )}

          <div className='mt-6 flex justify-center'>
            <button
              onClick={() => navigate('/onboarding')}
              className='inline-flex items-center gap-1.5 text-xs text-text-muted/70 hover:text-text-primary transition-colors'
            >
              <Sparkles size={12} /> Setup wizard
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const UPCOMING_SHOWN = 8

/**
 * Sort the day's runs into the page's sections. A failure "needs you" until a
 * later run of the same routine succeeds — a retry that worked, or the next
 * scheduled fire — and repeated failures of one routine collapse into its
 * latest, with the count.
 */
function partition(runs: RunListItem[]) {
  const dayStart = startOfToday()
  const waiting = runs.filter((r) => r.status === 'needs_you')
  const running = runs.filter((r) => r.status === 'running')
  const doneToday = runs.filter((r) => r.status !== 'running' && r.status !== 'needs_you' && r.status !== 'error' && r.started_at >= dayStart)

  const needsYou: { run: RunListItem; attempts: number }[] = []
  const seen = new Set<string>()
  for (const run of runs) {
    if (run.status !== 'error') continue
    const key = run.source_id ?? run.id
    if (seen.has(key)) continue
    seen.add(key)
    const later = runs.some((r) => r.source_id && r.source_id === run.source_id && r.status === 'done' && r.started_at > run.started_at)
    if (later) continue
    const attempts = runs.filter((r) => r.status === 'error' && (r.source_id ?? r.id) === key).length
    needsYou.push({ run, attempts })
  }
  return { waiting, needsYou, running, doneToday }
}

function Section({ title, count, testId, children }: { title: string; count?: number; testId: string; children: React.ReactNode }) {
  return (
    <section className='mt-5' data-testid={testId}>
      <h2 className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted'>
        {title}{count != null && <span className='font-normal'> · {count}</span>}
      </h2>
      <div className='rounded-xl border border-border bg-surface divide-y divide-border'>{children}</div>
    </section>
  )
}

/**
 * One run, the way the sketch draws it: icon, name and state, the one line it
 * produced, where and when — and its actions, beside it on a desk, under it on
 * a phone where they become two full-width buttons.
 */
function Row({
  run, summary, tone, meta, chat, onChat, actions,
}: {
  run: RunListItem
  summary: string | null
  tone?: 'danger'
  meta: (string | null)[]
  chat?: string
  onChat: () => void
  actions: React.ReactNode
}) {
  const Icon = run.kind === 'webhook' ? Link2 : Clock
  return (
    <div className='flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3' data-testid='today-row' data-status={run.status}>
      <div className='flex min-w-0 flex-1 items-start gap-3'>
        <div className='mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface2 text-text-muted'><Icon size={13} /></div>
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
            <span className='truncate text-sm font-medium text-text-primary'>{run.source_name}</span>
            <StatusPill run={run} />
          </div>
          {summary && (
            <div className={`mt-0.5 text-[13px] leading-snug line-clamp-2 ${tone === 'danger' ? 'text-danger' : 'text-text-secondary'}`}>
              {firstLine(summary)}
            </div>
          )}
          <div className='mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-text-muted'>
            {meta.filter(Boolean).map((m) => <span key={m as string}>{m}</span>)}
            {chat && (
              <button onClick={onChat} className='inline-flex items-center gap-1 hover:text-text-primary transition-colors'>
                <MessageSquare size={10} /> {chat}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className='grid grid-cols-2 gap-2 pl-10 sm:flex sm:shrink-0 sm:items-center sm:gap-1.5 sm:pl-0 sm:pt-0.5'>{actions}</div>
    </div>
  )
}

function ActionButton({
  children, onClick, primary, danger, disabled, title,
}: {
  children: React.ReactNode
  onClick: () => void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  title?: string
}) {
  const look = primary
    ? 'bg-accent text-white border-accent hover:bg-accent-hover'
    : danger
      ? 'border-border text-text-secondary hover:border-danger/50 hover:text-danger'
      : 'border-border text-text-secondary hover:bg-surface2 hover:text-text-primary'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${look}`}
    >
      {children}
    </button>
  )
}

