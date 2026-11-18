import Select from './Select'
import { describeSchedule } from '../lib/runs'
import { buildSchedule, DAY_NAMES, FREQ_LABELS, type Freq, type Schedule } from '../lib/schedule'

export const FIELD = 'h-8 rounded-lg border border-border bg-bg px-2.5 text-[13px] text-text-primary transition-colors hover:border-text-muted/50 focus:border-accent focus:outline-none'

/**
 * When a routine runs, as the few shapes people pick — every hour, every day
 * at…, on weekdays, every week on… — and a raw cron expression for the rest.
 * Shared by the routine's card and the composer that starts one.
 */
export default function ScheduleFields({ schedule, onChange }: { schedule: Schedule; onChange: (patch: Partial<Schedule>) => void }) {
  const cronExpr = buildSchedule(schedule)
  const words = cronExpr ? describeSchedule(cronExpr) : ''
  return (
    <>
      <Select
        aria-label='How often'
        value={schedule.freq}
        options={FREQ_LABELS.map(([f, label]) => ({ value: f, label }))}
        onChange={(f: Freq) => onChange({ freq: f, cron: cronExpr || schedule.cron })}
      />
      {schedule.freq === 'weekly' && (
        <Select
          aria-label='Day'
          value={schedule.day}
          options={DAY_NAMES.map((d, i) => ({ value: i, label: `on ${d}` }))}
          onChange={(day: number) => onChange({ day })}
        />
      )}
      {schedule.freq === 'hourly' && (
        <label className='inline-flex items-center gap-1 text-text-muted'>
          at :
          <input type='number' min={0} max={59} value={schedule.minute} onChange={(e) => onChange({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} className={`${FIELD} w-14`} aria-label='Minute' />
        </label>
      )}
      {['daily', 'weekdays', 'weekly'].includes(schedule.freq) && (
        <input type='time' value={schedule.time} onChange={(e) => onChange({ time: e.target.value })} className={FIELD} aria-label='Time' />
      )}
      {schedule.freq === 'custom' && (
        <input value={schedule.cron} onChange={(e) => onChange({ cron: e.target.value })} placeholder='0 7 * * *' className={`${FIELD} w-32 font-mono`} aria-label='Schedule' />
      )}
      {schedule.freq === 'custom' && words && words !== cronExpr && <span className='text-[12px] text-text-muted'>{words}</span>}
    </>
  )
}
