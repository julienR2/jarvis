import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Clock, Link2, Loader2, MessageSquare, RotateCcw, Settings2, Square, X } from 'lucide-react'
import ChatInput from '../components/ChatInput'
import NeedsYouCard from '../components/NeedsYouCard'
import { SidebarToggle } from '../components/ContentLayout'
import { api, pendingQuestionOf, type Attachment, type RunListItem, type UpcomingCron } from '../api'
import { useChatStore } from '../stores/chatStore'
import { BASE_PATH } from '../base'
import { firstLine, formatTime, reloadRecentRuns, startOfToday, upcomingLabel, useRecentRuns, useRunsNudge } from '../lib/runs'

/**
 * Home — an inbox, not a log.
 *
 * A greeting and the composer first: the assistant is still the point. Under
 * it, only what asks for you or is worth a glance, in the order it matters:
 * what Jarvis is waiting on (a question, an approval, a failure), what is
 * running now, the few results worth telling you — each put away with a click
 * — and what comes next. Runs with nothing to say are counted on one line; the
 * full record of what a routine did lives in the chat it posts into.
 *
 * A quiet day shows the greeting and the composer and nothing else: no empty
 * boxes, no padding. Every section appears only when it has something to say.
 */
export default function TodayPage() {
  const navigate = useNavigate()
  const conversations = useChatStore((s) => s.conversations)
  // Since yesterday: a run that started late last night and is still going
  // is "running", and a failure from last night still waits.
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

  const { waiting, needsYou, running, doneToday, quietToday } = useMemo(() => partition(runs ?? []), [runs])

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

  async function act(run: RunListItem, what: 'stop' | 'retry' | 'dismiss') {
    setBusy((b) => ({ ...b, [run.id]: true }))
    try {
      if (what === 'stop') await api.stopRun(run.id)
      else if (what === 'retry') await api.retryRun(run.id)
      else await api.dismissRun(run.id)
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
  const needsCount = interactiveWaiting.length + waiting.length + needsYou.length

  return (
    <div className='flex flex-col h-full'>
      <div className='shrink-0 border-b border-border'>
        <div className='flex items-center gap-2 h-12 px-3 md:px-6'>
          <SidebarToggle />
          <h1 className='text-sm font-medium text-text-primary'>Today</h1>
          <span className='text-xs text-text-muted'>{dateLine}</span>
        </div>
      </div>

      <div className='flex-1 overflow-y-auto'>
        {/* Hero — Jarvis waving, as home always opened. The composer right under it. */}
        <div className='flex flex-col items-center px-4 pt-8 pb-1'>
          <img
            src={`${BASE_PATH}/images/jarvis_wave.gif`}
            alt='Jarvis'
            className='mb-3 h-20 w-20 mix-blend-multiply dark:mix-blend-screen'
          />
          <h2 className='text-2xl font-light text-text-primary'>{getGreeting()}</h2>
          <p className='mt-1 text-sm text-text-muted'>How can I help you today?</p>
        </div>
        <div className='pt-2'>
          <ChatInput
            onSend={start}
            onSendAudio={startWithAudio}
            onCancel={() => {}}
            isProcessing={false}
            autoFocus
          />
        </div>

        <div className='max-w-3xl mx-auto px-4 md:px-6 pb-10'>
          {loadError && runs === null && (
            <div className='py-6 text-center text-sm text-text-muted'>
              Couldn't load today's inbox. <button onClick={() => load()} className='underline hover:text-text-primary'>Try again</button>
            </div>
          )}

          {needsCount > 0 && (
            <Section title='Needs you' count={needsCount} testId='today-needs'>
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
                {/* Then failures that need a fix — a list, since they read as one. */}
                {needsYou.length > 0 && (
                  <div className='divide-y divide-border'>
                    {needsYou.map(({ run, attempts }) => (
                      <InboxRow
                        key={run.id}
                        run={run}
                        icon={<AlertCircle size={13} className='text-danger' />}
                        lead={run.error ? firstLine(run.error) : `${run.source_name} failed`}
                        tone='danger'
                        meta={[run.source_name, formatTime(run.started_at), attempts > 1 ? `${attempts} attempts` : null]}
                        chat={convTitle(run.conversation_id)}
                        onOpen={() => open(run.conversation_id)}
                        actions={
                          <>
                            <TextButton onClick={() => open(run.conversation_id)}>{openLabel(run.conversation_id)}</TextButton>
                            {run.kind === 'cron' && run.source_id && (
                              <TextButton primary disabled={!!busy[run.id]} onClick={() => act(run, 'retry')} title='Run it again'>
                                <RotateCcw size={11} /> Retry
                              </TextButton>
                            )}
                          </>
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            </Section>
          )}

          {running.length > 0 && (
            <Section title='Running' testId='today-now'>
              <div className='divide-y divide-border'>
                {running.map((run) => (
                  <InboxRow
                    key={run.id}
                    run={run}
                    icon={<Loader2 size={13} className='animate-spin text-accent' />}
                    lead={run.source_name}
                    meta={[`since ${formatTime(run.started_at)}`]}
                    chat={convTitle(run.conversation_id)}
                    onOpen={() => open(run.conversation_id)}
                    actions={
                      <TextButton danger disabled={!!busy[run.id]} onClick={() => act(run, 'stop')} title='Stop this run'>
                        <Square size={10} fill='currentColor' /> Stop
                      </TextButton>
                    }
                  />
                ))}
              </div>
            </Section>
          )}

          {doneToday.length > 0 && (
            <Section title='Worth telling you' testId='today-done'>
              <div className='divide-y divide-border'>
                {doneToday.map((run) => (
                  <InboxRow
                    key={run.id}
                    run={run}
                    icon={run.kind === 'webhook' ? <Link2 size={13} className='text-text-muted' /> : <Clock size={13} className='text-text-muted' />}
                    lead={run.result ? firstLine(run.result) : run.error ? firstLine(run.error) : run.source_name}
                    tone={run.status === 'done' ? undefined : 'muted'}
                    meta={[run.source_name, formatTime(run.started_at), run.status === 'done' ? null : run.status]}
                    chat={convTitle(run.conversation_id)}
                    onOpen={() => open(run.conversation_id)}
                    actions={
                      <>
                        <TextButton onClick={() => open(run.conversation_id)}>{openLabel(run.conversation_id)}</TextButton>
                        <button
                          onClick={() => act(run, 'dismiss')}
                          disabled={!!busy[run.id]}
                          title='Put away'
                          aria-label={`Put away ${run.source_name}`}
                          className='rounded-md p-1 text-text-muted/60 transition-colors hover:bg-surface2 hover:text-text-primary disabled:opacity-40'
                        >
                          <X size={13} />
                        </button>
                      </>
                    }
                  />
                ))}
              </div>
            </Section>
          )}

          {quietToday.length > 0 && (
            <div className='mt-4 flex items-center gap-2 text-[11.5px] text-text-muted' data-testid='today-quiet'>
              <span>{quietToday.length} {quietToday.length === 1 ? 'run' : 'runs'} had nothing to report</span>
              <span className='h-px flex-1 border-t border-dashed border-border' />
              <span className='truncate'>{[...new Set(quietToday.map((r) => r.source_name))].join(', ')}</span>
            </div>
          )}

          {upcoming.length > 0 && (
            <Section title='Coming up' testId='today-upcoming'>
              <div className='divide-y divide-border'>
                {upcoming.slice(0, UPCOMING_SHOWN).map((cron) => (
                  <div key={cron.id} className='group flex items-center gap-3 py-2' data-testid='today-row'>
                    <Clock size={13} className='shrink-0 text-text-muted' />
                    <div className='min-w-0 flex-1'>
                      <span className='text-[13.5px] text-text-primary'>{cron.name}</span>
                      <span className='ml-2 text-[12px] text-text-muted'>{cron.next_run ? upcomingLabel(cron.next_run) : 'not scheduled'}</span>
                      {convTitle(cron.conversation_id) && (
                        <button onClick={() => open(cron.conversation_id)} className='ml-2 inline-flex items-center gap-1 text-[11.5px] text-text-muted hover:text-text-primary transition-colors'>
                          <MessageSquare size={10} /> {convTitle(cron.conversation_id)}
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => navigate(`/routines?edit=${cron.id}`)}
                      title='Open this routine'
                      className='rounded-md p-1 text-text-muted/50 hover:bg-surface2 hover:text-text-primary'
                    >
                      <Settings2 size={13} />
                    </button>
                  </div>
                ))}
                {upcoming.length > UPCOMING_SHOWN && (
                  <button onClick={() => navigate('/routines')} className='w-full py-2 text-left text-[12px] text-text-muted hover:text-text-primary'>
                    {upcoming.length - UPCOMING_SHOWN} more in Routines
                  </button>
                )}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

const UPCOMING_SHOWN = 5

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * Sort the day's runs into the page's sections. A failure "needs you" until a
 * later run of the same routine succeeds — a retry that worked, or the next
 * scheduled fire — and repeated failures of one routine collapse into its
 * latest, with the count. A finished run is listed once: put away, it stays
 * in its chat and leaves the page.
 */
function partition(runs: RunListItem[]) {
  const dayStart = startOfToday()
  const waiting = runs.filter((r) => r.status === 'needs_you')
  const running = runs.filter((r) => r.status === 'running')
  const finished = runs.filter((r) => r.status !== 'running' && r.status !== 'needs_you' && r.status !== 'error' && r.started_at >= dayStart)
  // A run that had nothing to report is counted, not listed.
  const doneToday = finished.filter((r) => !r.quiet && !r.dismissed)
  const quietToday = finished.filter((r) => !!r.quiet)

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
  return { waiting, needsYou, running, doneToday, quietToday }
}

function Section({ title, count, testId, children }: { title: string; count?: number; testId: string; children: React.ReactNode }) {
  return (
    <section className='mt-6' data-testid={testId}>
      <h2 className='mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted'>
        {title}{count != null && <span className='font-normal'> · {count}</span>}
      </h2>
      {children}
    </section>
  )
}

/**
 * One inbox line. The content leads — what the run said, or what went wrong —
 * and the routine, the time and the chat sit under it in small type; the
 * actions keep to the right. Frameless: a divider between rows is the only
 * chrome, so a full day still reads as a list and not as a wall of cards.
 */
function InboxRow({
  run, icon, lead, tone, meta, chat, onOpen, actions,
}: {
  run: RunListItem
  icon: React.ReactNode
  lead: string
  tone?: 'danger' | 'muted'
  meta: (string | null)[]
  chat?: string
  onOpen: () => void
  actions: React.ReactNode
}) {
  const leadClass = tone === 'danger' ? 'text-danger' : tone === 'muted' ? 'text-text-secondary' : 'text-text-primary'
  return (
    <div className='flex items-start gap-3 py-2.5' data-testid='today-row' data-status={run.status}>
      <span className='mt-1 shrink-0'>{icon}</span>
      <button onClick={onOpen} className='min-w-0 flex-1 text-left'>
        <div className={`text-[14px] leading-snug line-clamp-2 ${leadClass}`}>{lead}</div>
        <div className='mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-text-muted'>
          {meta.filter(Boolean).map((m, i) => (
            <span key={m as string} className='inline-flex items-center gap-1.5'>
              {i > 0 && <span className='opacity-60'>·</span>}
              {m}
            </span>
          ))}
          {chat && (
            <span className='inline-flex items-center gap-1.5'>
              <span className='opacity-60'>·</span>
              <span className='inline-flex items-center gap-1'><MessageSquare size={10} /> {chat}</span>
            </span>
          )}
        </div>
      </button>
      <div className='flex shrink-0 items-center gap-1 pt-0.5'>{actions}</div>
    </div>
  )
}

function TextButton({
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
    ? 'border-accent bg-accent text-white hover:bg-accent-hover'
    : danger
      ? 'border-transparent text-text-muted hover:text-danger hover:bg-surface2'
      : 'border-transparent text-text-secondary hover:bg-surface2 hover:text-text-primary'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40 ${look}`}
    >
      {children}
    </button>
  )
}
