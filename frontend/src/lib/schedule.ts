/**
 * A cron expression as the routine card edits it: the few shapes people
 * actually pick, and "custom" for everything else (kept as typed).
 */
export type Freq = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

export interface Schedule {
  freq: Freq
  /** HH:MM for daily/weekdays/weekly. */
  time: string
  /** Minute past the hour, for hourly. */
  minute: number
  /** 0 = Sunday … 6 = Saturday, for weekly. */
  day: number
  /** The raw expression, for custom. */
  cron: string
}

export const FREQ_LABELS: [Freq, string][] = [
  ['hourly', 'Every hour'],
  ['daily', 'Every day'],
  ['weekdays', 'On weekdays'],
  ['weekly', 'Every week'],
  ['custom', 'Custom (cron)'],
]

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const num = (s: string) => /^\d+$/.test(s)
const pad = (n: number | string) => String(n).padStart(2, '0')

export function parseSchedule(expr: string): Schedule {
  const base: Schedule = { freq: 'daily', time: '07:00', minute: 0, day: 1, cron: expr.trim() }
  const parts = expr.trim().split(/\s+/)
  if (!expr.trim()) return base
  if (parts.length !== 5) return { ...base, freq: 'custom' }
  const [min, hour, dom, mon, dow] = parts
  if (dom !== '*' || mon !== '*' || !num(min)) return { ...base, freq: 'custom' }
  if (hour === '*' && dow === '*') return { ...base, freq: 'hourly', minute: Number(min) }
  if (!num(hour)) return { ...base, freq: 'custom' }
  const time = `${pad(hour)}:${pad(min)}`
  if (dow === '*') return { ...base, freq: 'daily', time }
  if (dow === '1-5') return { ...base, freq: 'weekdays', time }
  if (/^[0-6]$/.test(dow)) return { ...base, freq: 'weekly', time, day: Number(dow) }
  return { ...base, freq: 'custom' }
}

export function buildSchedule(s: Schedule): string {
  const [h, m] = s.time.split(':').map((x) => Number(x) || 0)
  switch (s.freq) {
    case 'hourly': return `${s.minute} * * * *`
    case 'daily': return `${m} ${h} * * *`
    case 'weekdays': return `${m} ${h} * * 1-5`
    case 'weekly': return `${m} ${h} * * ${s.day}`
    default: return s.cron.trim()
  }
}
