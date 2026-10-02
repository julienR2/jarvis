import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import Popover from './Popover'

export interface SelectOption<T extends string | number> {
  value: T
  label: string
  /** Drawn before the label, in the list and on the button. */
  icon?: ReactNode
  /** A second, quieter line under the label in the list. */
  hint?: string
}

/**
 * A dropdown that looks like the rest of the app: the native <select> is drawn
 * by the browser (Safari's especially), and never matched the cards it sat in.
 *
 * Opens a list under the button; arrows move, Enter picks, Escape closes. Long
 * lists get a filter box. `aria-label` names it, as a <select> would be named.
 */
export default function Select<T extends string | number>({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
  placeholder = 'Choose…',
  disabled,
  className = '',
  searchable,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  'aria-label': string
  placeholder?: string
  disabled?: boolean
  className?: string
  /** A filter box at the top. Default: on for more than 8 options. */
  searchable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)
  const filter = searchable ?? options.length > 8
  const shown = filter && query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  function pick(o: SelectOption<T>) {
    onChange(o.value)
    setOpen(false)
    btnRef.current?.focus()
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const o = shown[active]; if (o) pick(o) }
  }

  return (
    <>
      <button
        ref={btnRef}
        type='button'
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup='listbox'
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true) }
          else if (open) onKey(e)
        }}
        className={`inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-lg border bg-bg pl-2.5 pr-2 text-[13px] transition-colors disabled:opacity-50 ${open ? 'border-accent' : 'border-border hover:border-text-muted/50'} ${className}`}
      >
        {current?.icon && <span className='shrink-0 text-text-muted'>{current.icon}</span>}
        <span className={`min-w-0 flex-1 truncate text-left ${current ? 'text-text-primary' : 'text-text-muted'}`}>{current?.label ?? placeholder}</span>
        <ChevronDown size={13} className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} placement='bottom-start' className='min-w-[180px] max-w-[min(360px,calc(100vw-24px))] rounded-xl border border-border bg-surface p-1 shadow-lg'>
        {filter && (
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={onKey}
            placeholder='Filter…'
            aria-label={`Filter ${ariaLabel}`}
            className='mb-1 w-full rounded-lg bg-surface2 px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none'
          />
        )}
        <div ref={listRef} role='listbox' aria-label={ariaLabel}>
          {shown.map((o, i) => {
            const selected = o.value === value
            return (
              <button
                key={String(o.value)}
                type='button'
                role='option'
                aria-selected={selected}
                data-index={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors ${i === active ? 'bg-surface2' : ''} ${selected ? 'text-text-primary font-medium' : 'text-text-secondary'}`}
              >
                {o.icon && <span className='shrink-0 text-text-muted'>{o.icon}</span>}
                <span className='min-w-0 flex-1'>
                  <span className='block truncate'>{o.label}</span>
                  {o.hint && <span className='block truncate text-[11.5px] font-normal text-text-muted'>{o.hint}</span>}
                </span>
                {selected && <Check size={13} className='shrink-0 text-accent' />}
              </button>
            )
          })}
          {shown.length === 0 && <div className='px-2 py-2 text-[12.5px] text-text-muted'>Nothing matches.</div>}
        </div>
      </Popover>
    </>
  )
}
