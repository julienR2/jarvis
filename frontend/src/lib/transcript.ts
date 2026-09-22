import type { Message, Run } from '../api'

/**
 * A conversation's messages, grouped the way the chat draws them: day
 * separators, a run's contiguous messages as one block, runs that had nothing
 * to report left out. Shared by ChatView and Today's inbox cards, so the same
 * messages look the same in both places.
 */
export type MessageItem =
  | { type: 'message'; msg: Message }
  | { type: 'separator'; key: string; label: string }
  | { type: 'unread'; key: string }
  | { type: 'runBlock'; key: string; runId: string; isolated: boolean; msgs: Message[] }

/**
 * A run with nothing to report prints nothing — no card, no line. Its
 * messages carry the mark once the run closes; the run row covers the moments
 * before the client has the stamped copy.
 */
export function isQuietMessage(msg: Message, runsById?: Map<string, Run>): boolean {
  const run = messageRun(msg)
  if (!run) return false
  if (run.quiet) return true
  const row = runsById?.get(run.runId)
  return !!row?.quiet && row.status === 'done'
}

/**
 * A finished answer worth reading: the unit the unread count, the divider and
 * the arrow badge share (the server counts the same rows for the sidebar).
 */
export function isFinishedReply(msg: Message, runsById?: Map<string, Run>): boolean {
  return msg.role === 'assistant' && !msg.type && msg.result != null && !isQuietMessage(msg, runsById)
}

/**
 * Drop the blocks of quiet runs, then whatever marker they leave pointing at
 * nothing: a day with only silent fires loses its separator, and a divider
 * with nothing under it goes too.
 */
export function dropQuietRuns(items: MessageItem[], runsById: Map<string, Run>): MessageItem[] {
  const kept = items.filter((item) => !(item.type === 'runBlock' && item.msgs.every((m) => isQuietMessage(m, runsById))))
  const isContent = (n: MessageItem) => n.type === 'message' || n.type === 'runBlock'
  return kept.filter((item, i) => {
    const rest = kept.slice(i + 1)
    if (item.type === 'unread') return rest.some(isContent)
    if (item.type === 'separator') {
      const next = rest.find((n) => n.type !== 'unread')
      return !!next && isContent(next)
    }
    return true
  })
}

/** The run a message was written by, from the metadata the backend stamps on. */
export function messageRun(msg: Message): { runId: string; isolated: boolean; quiet: boolean } | null {
  if (!msg.metadata) return null
  try {
    const parsed = JSON.parse(msg.metadata)
    if (typeof parsed?.run_id !== 'string') return null
    return { runId: parsed.run_id, isolated: !!parsed.isolated, quiet: parsed.quiet === true }
  } catch {
    return null
  }
}

export function groupMessagesByDay(messages: Message[], unreadAnchor: string | null): MessageItem[] {
  const result: MessageItem[] = []
  let lastDay = ''
  let lastRunId: string | null = null

  for (const msg of messages) {
    const date = new Date((msg.created_at || 0) * 1000)
    const dayKey = date.toDateString()

    if (dayKey !== lastDay) {
      lastDay = dayKey
      result.push({ type: 'separator', key: `sep-${dayKey}`, label: formatDayLabel(date) })
      // A day separator already breaks the block visually, so the next run
      // marker has to be re-drawn even if the run id happens to be unchanged.
      lastRunId = null
    }

    // A run's contiguous messages become one block, rendered as a card. A cron
    // writes an activity message, then a result, sometimes an error — shown one
    // by one they were forty lines of machinery for a single event.
    const run = messageRun(msg)
    if (run) {
      const last = result[result.length - 1]
      const continues = run.runId === lastRunId && last?.type === 'runBlock'
      if (continues) {
        // The divider must not split the block in two (two cards, two gears for
        // one run): when the first unread message is inside a run, the divider
        // goes above the whole block — the run's output is one piece of news.
        if (msg.id === unreadAnchor) result.splice(result.length - 1, 0, { type: 'unread', key: `unread-${msg.id}` })
        last.msgs.push(msg)
      } else {
        // Below the day separator, not above it: the divider marks where
        // reading resumes, and that is inside the day, not before it.
        if (msg.id === unreadAnchor) result.push({ type: 'unread', key: `unread-${msg.id}` })
        result.push({
          type: 'runBlock',
          key: `run-${run.runId}-${msg.id}`,
          runId: run.runId,
          isolated: run.isolated,
          msgs: [msg],
        })
      }
      lastRunId = run.runId
      continue
    }
    lastRunId = null
    if (msg.id === unreadAnchor) result.push({ type: 'unread', key: `unread-${msg.id}` })
    result.push({ type: 'message', msg })
  }

  return result
}

export function formatDayLabel(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

  const diffDays = Math.floor((today.getTime() - date.getTime()) / 86_400_000)
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'long' })
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })
}
