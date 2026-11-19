import type { ReactNode } from 'react'
import { Plus } from 'lucide-react'

export interface RowAction {
  label: string
  icon: ReactNode
  run: () => void
}

/**
 * One row of a chat's # list — a side chat or a routine, drawn the same way:
 * icon and title, how recent (or how many unread) on the right. Its actions
 * show on hover; on a touch screen they stay.
 */
export function SubChatRow({ icon, title, right, fresh, selected, muted, onOpen, actions, testId }: {
  icon: ReactNode
  title: string
  right?: ReactNode
  /** Has something you haven't seen. */
  fresh?: boolean
  selected?: boolean
  muted?: boolean
  onOpen: () => void
  actions: RowAction[]
  testId: string
}) {
  return (
    <div className={`group flex items-start gap-1 rounded-lg ${selected ? 'bg-surface2' : 'hover:bg-surface2'}`} data-testid={testId}>
      <button onClick={onOpen} className={`flex min-w-0 flex-1 items-start gap-2 px-2.5 py-1.5 text-left ${muted ? 'opacity-60' : ''}`}>
        <span className='flex h-[1lh] shrink-0 items-center text-[12.5px]'>{icon}</span>
        <span className='flex min-w-0 flex-1 items-baseline gap-2'>
          <span className={`truncate text-[12.5px] text-text-primary ${fresh ? 'font-semibold' : ''}`}>{title}</span>
          <span className='ml-auto shrink-0 text-[10.5px] text-text-muted'>{right}</span>
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

/** "＋ New …", with a line on what it is for when it needs one. */
export function CreateRow({ label, hint, onClick, busy }: { label: string; hint?: string; onClick: () => void; busy?: boolean }) {
  return (
    <button onClick={onClick} disabled={busy} className='flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface2 disabled:opacity-60'>
      <span className='flex h-[1lh] shrink-0 items-center text-[12.5px]'><Plus size={12} className='text-text-muted' /></span>
      <span className='min-w-0'>
        <span className='block text-[12.5px] text-text-secondary'>{label}</span>
        {hint && <span className='block text-[11px] leading-snug text-text-muted'>{hint}</span>}
      </span>
    </button>
  )
}
