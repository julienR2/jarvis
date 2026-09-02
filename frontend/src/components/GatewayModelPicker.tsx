import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Check, Search } from 'lucide-react'
import type { ModelOption } from './ModelSelector'

/**
 * Choosing from a gateway catalogue.
 *
 * A gateway serves hundreds of models, so this is a modal rather than a menu:
 * the four most popular (the gateway's own usage ranking, not a guess) are
 * there to pick immediately, and search reaches the rest. The modality filter
 * is for the narrow case the list is otherwise hopeless for — finding the
 * eleven models that can emit an image among four hundred that emit text.
 */
const VISIBLE = 4

/** Only worth offering as filters; nearly every model emits text. */
const MODALITIES = ['image', 'audio'] as const

export default function GatewayModelPicker({
  models,
  selected,
  onSelect,
  onClose,
}: {
  models: ModelOption[]
  selected?: string
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [modality, setModality] = useState<string | null>(null)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models.filter((m) => {
      if (modality && !m.outputs?.includes(modality)) return false
      if (!q) return true
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    })
  }, [models, query, modality])

  // Cap the list even when searching: if what you want isn't in the first few,
  // refining the query beats scrolling four hundred rows.
  const visible = matches.slice(0, VISIBLE)
  const hidden = matches.length - visible.length

  return createPortal(
    <div
      className='fixed inset-0 z-[600] bg-black/50 flex items-start justify-center p-4 pt-[10vh]'
      onClick={onClose}
    >
      <div
        className='bg-surface border border-border rounded-2xl shadow-xl w-full max-w-lg overflow-hidden'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex items-center gap-2 px-4 py-3 border-b border-border'>
          <h2 className='text-sm font-semibold text-text-primary flex-1'>
            Choose a model
          </h2>
          <span className='text-xs text-text-muted'>{models.length} available</span>
          <button onClick={onClose} className='text-text-muted hover:text-text-primary p-1'>
            <X size={16} />
          </button>
        </div>

        <div className='px-4 pt-3 pb-2 flex flex-col gap-2'>
          <div className='relative'>
            <Search
              size={14}
              className='absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none'
            />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search models…'
              className='w-full bg-bg border border-border rounded-xl pl-9 pr-3 py-2 text-sm text-text-primary outline-none focus:border-accent'
            />
          </div>

          <div className='flex gap-1.5'>
            <FilterChip active={!modality} onClick={() => setModality(null)}>
              All
            </FilterChip>
            {MODALITIES.map((m) => (
              <FilterChip
                key={m}
                active={modality === m}
                onClick={() => setModality(modality === m ? null : m)}
              >
                Outputs {m}
              </FilterChip>
            ))}
          </div>
        </div>

        <div className='px-2 pb-2'>
          {!query && !modality && (
            <p className='px-2 pb-1 text-[11px] text-text-muted uppercase tracking-wide'>
              Most popular
            </p>
          )}

          {visible.map((m) => (
            <button
              key={m.id}
              onClick={() => { onSelect(m.id); onClose() }}
              className={`w-full flex items-center gap-3 text-left px-3 py-2.5 rounded-xl transition-colors ${
                selected === m.id ? 'bg-accent/10' : 'hover:bg-surface2'
              }`}
            >
              <span className='flex-1 min-w-0'>
                <span
                  className={`block text-sm font-medium truncate ${
                    selected === m.id ? 'text-accent' : 'text-text-primary'
                  }`}
                >
                  {m.name}
                </span>
                <span className='block text-xs text-text-muted truncate font-mono'>
                  {m.id}
                  {m.desc ? ` · ${m.desc}` : ''}
                </span>
              </span>
              {selected === m.id && <Check size={16} className='text-accent shrink-0' />}
            </button>
          ))}

          {matches.length === 0 && (
            <p className='px-3 py-4 text-sm text-text-muted text-center'>
              Nothing matches that.
            </p>
          )}
          {hidden > 0 && (
            <p className='px-3 pt-1.5 pb-1 text-xs text-text-muted'>
              +{hidden} more — refine your search to see them.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function FilterChip({
  active, onClick, children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-xs transition-colors border ${
        active
          ? 'border-accent text-accent bg-accent/10'
          : 'border-border text-text-muted hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}
