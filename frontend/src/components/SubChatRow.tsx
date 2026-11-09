import type { ReactNode } from 'react'
import { Plus } from 'lucide-react'

export interface RowAction {
  label: string
  icon: ReactNode
  run: () => void
}

/**
 * One row of a chat's # list — a side chat or a routine, drawn the same way:
 * icon and title, how recent on the right, one grey line under it (the
 * passage it came from, or when the routine runs and what it last did). Its
 * actions show on hover; on a touch screen they stay.
 */
export function SubChatRow({ icon, title, right, sub, italicSub, fresh, selected, muted, tag, onOpen, openLabel, actions, testId }: {
  icon: ReactNode
  title: string
  right?: ReactNode
  sub?: string
  /** The sub line is a quote. */
  italicSub?: boolean
  /** Has something you haven't seen. */
  fresh?: boolean
  selected?: boolean
  muted?: boolean
  /** A small label after the title ("Paused"). */
  tag?: string
  onOpen: () => void
  openLabel?: string
  actions: RowAction[]
  testId: string
}) {
  return (
    <div className={`group flex items-start gap-1 rounded-lg ${selected ? 'bg-surface2' : 'hover:bg-surface2'}`} data-testid={testId}>
      <button onClick={onOpen} title={openLabel} className={`flex min-w-0 flex-1 items-start gap-2 px-2.5 py-1.5 text-left ${muted ? 'opacity-60' : ''}`}>
        <span className='mt-0.5 shrink-0'>{icon}</span>
        <span className='min-w-0 flex-1'>
          <span className='flex items-baseline gap-2'>
            <span className={`truncate text-[12.5px] text-text-primary ${fresh ? 'font-semibold' : ''}`}>{title}</span>
            {tag && <span className='shrink-0 rounded bg-surface2 px-1 text-[10px] text-text-muted'>{tag}</span>}
            <span className='ml-auto shrink-0 text-[10.5px] text-text-muted'>{right}</span>
          </span>
          {sub && <span className={`mt-0.5 block truncate text-[11px] text-text-muted ${italicSub ? 'italic' : ''}`}>{italicSub ? `❝ ${sub}` : sub}</span>}
        </span>
      </button>
      {actions.length > 0 && (
        <span className='mr-1 mt-1 flex shrink-0 items-center opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100'>
          {actions.map((a) => (
            <button key={a.label} onClick={a.run} title={a.label} aria-label={a.label} className='rounded-md p-1 text-text-muted hover:bg-border hover:text-text-primary'>
              {a.icon}
            </button>
          ))}
        </span>
      )}
    </div>
  )
}

/** A section's title in the # list. */
export function ListHeading({ children }: { children: ReactNode }) {
  return <div className='px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted'>{children}</div>
}

/** "＋ New …" with the line that says what it is for. */
export function CreateRow({ label, hint, onClick, busy }: { label: string; hint: string; onClick: () => void; busy?: boolean }) {
  return (
    <button onClick={onClick} disabled={busy} className='flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface2 disabled:opacity-60'>
      <Plus size={12} className='mt-0.5 shrink-0 text-text-muted' />
      <span className='min-w-0'>
        <span className='block text-[12.5px] text-text-secondary'>{label}</span>
        <span className='block text-[11px] leading-snug text-text-muted'>{hint}</span>
      </span>
    </button>
  )
}
