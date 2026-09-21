import type { Message, Run } from '../api'

/**
 * A conversation's messages, grouped the way the chat draws them: day
 * separators, a run's contiguous messages as one block, consecutive quiet
 * runs folded into one line. Shared by ChatView and Today's inbox cards, so
 * the same messages look the same in both places.
 */
export type MessageItem =
  | { type: 'message'; msg: Message }
  | { type: 'separator'; key: string; label: string }
  | { type: 'unread'; key: string }
  | { type: 'runBlock'; key: string; runId: string; isolated: boolean; msgs: Message[] }
  | { type: 'quietRuns'; key: string; blocks: { run: Run; msgs: Message[] }[] }

/**
 * Consecutive runs that had nothing to report fold into one line. Needs the
 * run rows, so it is a pass over the grouped items rather than part of the
 * grouping: a block whose run is unknown (too old for the list) stays as is.
 */
export function foldQuietRuns(items: MessageItem[], runsById: Map<string, Run>): MessageItem[] {
  const out: MessageItem[] = []
  for (const item of items) {
    const run = item.type === 'runBlock' ? runsById.get(item.runId) : undefined
    if (item.type === 'runBlock' && run?.quiet && run.status === 'done') {
      const last = out[out.length - 1]
      if (last?.type === 'quietRuns') last.blocks.push({ run, msgs: item.msgs })
      else out.push({ type: 'quietRuns', key: `quiet-${item.key}`, blocks: [{ run, msgs: item.msgs }] })
      continue
    }
    out.push(item)
  }
  return out
}

/** The run a message was written by, from the metadata the backend stamps on. */
export function messageRun(msg: Message): { runId: string; isolated: boolean } | null {
  if (!msg.metadata) return null
  try {
    const parsed = JSON.parse(msg.metadata)
    if (typeof parsed?.run_id !== 'string') return null
    return { runId: parsed.run_id, isolated: !!parsed.isolated }
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
