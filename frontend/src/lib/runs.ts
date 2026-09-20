import { useEffect, useState } from 'react'
import { api, type RunListItem } from '../api'

/**
 * What Activity and Today share about runs: the words for a time, a duration,
 * a schedule, a summary's first line — and the window event that says "a run
 * started or ended somewhere, refetch".
 */

/** Dispatched by useGlobalEvents when the backend nudges `{type:'runs'}`. */
export const RUNS_NUDGE_EVENT = 'jarvis:runs'

/**
 * Call `load` once now, and again on every runs nudge — lightly debounced, so
 * a burst of fires refetches once rather than once per event.
 */
export function useRunsNudge(load: () => void): void {
  useEffect(() => {
    load()
    let timer: ReturnType<typeof setTimeout> | null = null
    const onNudge = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 400)
    }
    window.addEventListener(RUNS_NUDGE_EVENT, onNudge)
    return () => {
      window.removeEventListener(RUNS_NUDGE_EVENT, onNudge)
      if (timer) clearTimeout(timer)
    }
  }, [load])
}

// ── the recent-runs feed ─────────────────────────────────────────────────────
//
// Since yesterday, every status: what the sidebar's dots and the Today page
// both read. One fetch serves every listener, so landing on home costs one
// request rather than one per component, and the nudge refetches once.

type Feed = { runs: RunListItem[] | null; error: boolean }
const feed: Feed = { runs: null, error: false }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null
let fetchedAt = 0
let nudgeTimer: ReturnType<typeof setTimeout> | null = null
/** A subscriber arriving within this of the last fetch reads what is there. */
const FRESH_MS = 30_000

function emit() {
  for (const l of listeners) l()
}

export function reloadRecentRuns(): Promise<void> {
  if (inflight) return inflight
  inflight = api
    .listRunsAll({ since: startOfToday() - 86_400, limit: 100 })
    .then((rows) => {
      feed.runs = rows
      feed.error = false
      fetchedAt = Date.now()
    })
    .catch(() => {
      // A failed fetch is not an empty day: keep what we had, flag it.
      feed.error = true
    })
    .finally(() => {
      inflight = null
      emit()
    })
  return inflight
}

function onNudge() {
  if (nudgeTimer) clearTimeout(nudgeTimer)
  nudgeTimer = setTimeout(() => reloadRecentRuns(), 400)
}

/** The recent runs, fetched on mount and refetched on every runs nudge. */
export function useRecentRuns(): Feed {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    if (listeners.size === 1) window.addEventListener(RUNS_NUDGE_EVENT, onNudge)
    // The sidebar is mounted for the whole session and keeps the feed moving
    // through the nudge, so a page landing moments later reads what it has.
    if (feed.runs === null || Date.now() - fetchedAt > FRESH_MS) reloadRecentRuns()
    return () => {
      listeners.delete(l)
      if (listeners.size === 0) {
        window.removeEventListener(RUNS_NUDGE_EVENT, onNudge)
        if (nudgeTimer) clearTimeout(nudgeTimer)
      }
    }
  }, [])
  return feed.error ? { runs: feed.runs, error: true } : { runs: feed.runs, error: false }
}

export function groupByDay(runs: RunListItem[]): { label: string; runs: RunListItem[] }[] {
  const out: { label: string; runs: RunListItem[] }[] = []
  for (const run of runs) {
    const label = dayLabel(new Date(run.started_at * 1000))
    const last = out[out.length - 1]
    if (last && last.label === label) last.runs.push(run)
    else out.push({ label, runs: [run] })
  }
  return out
}

export function dayLabel(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  const diffDays = Math.floor((today.getTime() - date.getTime()) / 86_400_000)
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'long' })
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })
}

/**
 * A moment ahead of now, in words: "today 16:30", "tomorrow 05:30", "Wed 09:00",
 * and past a week the date. Local time — the scheduler thinks in UTC, the
 * reader doesn't.
 */
export function upcomingLabel(ts: number): string {
  const date = new Date(ts * 1000)
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const time = formatTime(ts)
  if (date.toDateString() === now.toDateString()) return `today ${time}`
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`
  const diffDays = (date.getTime() - now.getTime()) / 86_400_000
  if (diffDays < 7) return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}

/** A summary's first real line, with the markdown scaffolding taken off. */
export function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^\|?\s*:?-{2,}/.test(l)) ?? ''
  return line.replace(/^[#>*\-\s|]+/, '').replace(/\|/g, ' · ').replace(/\*\*/g, '').trim()
}

export function duration(start: number, end: number | null): string {
  const secs = Math.max(0, Math.floor((end ?? Date.now() / 1000) - start))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function relative(ts: number): string {
  const mins = Math.floor((Date.now() / 1000 - ts) / 60)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** A cron expression in words, for the common shapes; the raw one otherwise. */
export function describeSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hour, dom, mon, dow] = parts
  const time = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` : null
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`
  // Every N minutes / hours.
  const everyMin = /^\*\/(\d+)$/.exec(min)
  if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${everyMin[1]} min`
  const everyHour = /^\*\/(\d+)$/.exec(hour)
  if (everyHour && /^\d+$/.test(min) && dom === '*' && mon === '*' && dow === '*') {
    return everyHour[1] === '1' ? 'every hour' : `every ${everyHour[1]} hours`
  }
  if (!time) return expr
  if (dom === '*' && mon === '*') {
    if (dow === '*') return `daily at ${time}`
    if (dow === '1-5') return `weekdays at ${time}`
    if (dow === '0,6' || dow === '6,0') return `weekends at ${time}`
    const days = dow.split(',').map((d) => DAYS[Number(d)] ?? d).join(', ')
    return `${days} at ${time}`
  }
  if (/^\d+$/.test(dom) && mon === '*' && dow === '*') return `monthly on the ${ordinal(Number(dom))} at ${time}`
  if (/^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === '*') {
    return `every ${dom} ${MONTHS[Number(mon) - 1] ?? mon} at ${time}`
  }
  return expr
}

/** Local midnight, as the API counts time. */
export function startOfToday(): number {
  return Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)
}
