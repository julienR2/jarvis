import { useState, useRef, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import { ChevronDown, Check, Brain } from 'lucide-react'
import type { Effort } from '../api'

export interface ModelOption {
  id: string
  name: string
  desc: string
  /** Whether the model supports the effort parameter. Haiku does not. */
  effort?: boolean
}

/**
 * Fallback catalogue.
 *
 * The real list comes from GET /api/models, which reflects the active provider —
 * a gateway serves a different set entirely. This is what the picker shows
 * before that resolves, and if it fails.
 */
export const MODELS: ModelOption[] = [
  { id: 'claude-fable-5', name: 'Fable 5', desc: 'Most capable, for long-running agents' },
  { id: 'claude-opus-5', name: 'Opus 5', desc: 'Most capable — complex agentic coding & enterprise work' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', desc: 'Best mix of speed and intelligence' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', desc: 'Fastest, near-frontier', effort: false },
]

// Fetched from the server, then read synchronously by the pickers (which live
// in menus that can't easily be async).
//
// Reactive, because the catalogue changes during a session: switching provider
// swaps an Anthropic shortlist for a gateway's hundreds, and a picker still
// showing the old list would be wrong in a way the user can see.
let liveModels: ModelOption[] = MODELS
let liveAllowCustom = false
let snapshot: ModelOption[] = MODELS
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getModels(): ModelOption[] { return liveModels }
export function allowsCustomModel(): boolean { return liveAllowCustom }

/** Reactive read for components — re-renders when the catalogue changes. */
export function useModelCatalogue(): ModelOption[] {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/**
 * Load the catalogue for the active provider.
 *
 * Called at app start and again whenever the connection changes. Failures
 * leave whatever is loaded in place — a stale list beats an empty picker.
 */
export async function loadModelCatalogue(
  fetcher: () => Promise<{ models: ModelOption[]; allowCustom?: boolean }>,
): Promise<void> {
  try {
    const cat = await fetcher()
    if (cat.models?.length) liveModels = cat.models
    liveAllowCustom = !!cat.allowCustom
    snapshot = liveModels
    listeners.forEach((fn) => fn())
  } catch {
    // keep whatever is loaded
  }
}

export const DEFAULT_MODEL = 'claude-opus-5'

/**
 * The visible slice of a model list, with search.
 *
 * A gateway catalogue runs to hundreds of models, so the list is capped and
 * searchable rather than scrolled. The cap applies to search results too: if
 * what you typed isn't in the first few, the query is the thing to fix.
 *
 * Search appears only when there is enough to search — with four Anthropic
 * models a search box is noise.
 */
export const MODEL_VISIBLE_LIMIT = 4
const SEARCH_THRESHOLD = 8

export function useModelSearch(catalogue: ModelOption[], selected?: string) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  const matches = q
    ? catalogue.filter(
        (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      )
    : catalogue

  const visible = matches.slice(0, MODEL_VISIBLE_LIMIT)

  // The current model always has a row, even when it isn't in the top few or
  // doesn't match the query — a picker that can't show your own selection reads
  // as though it were unset.
  if (selected && !visible.some((m) => m.id === selected)) {
    const current = catalogue.find((m) => m.id === selected)
    if (current && !q) visible.push(current)
  }

  return {
    query,
    setQuery,
    visible,
    total: matches.length,
    hidden: Math.max(0, matches.length - MODEL_VISIBLE_LIMIT),
    searchable: catalogue.length > SEARCH_THRESHOLD,
  }
}

/** Effort levels exposed in the UI (the CLI also accepts `xhigh`). */
export const EFFORTS: { id: Effort; label: string; hint: string }[] = [
  { id: 'low', label: 'Low', hint: 'Fastest, minimal reasoning' },
  { id: 'medium', label: 'Med', hint: 'Lighter reasoning' },
  { id: 'high', label: 'High', hint: 'Balanced (default)' },
  { id: 'max', label: 'Max', hint: 'Most thorough, slowest' },
]

export const DEFAULT_EFFORT: Effort = 'high'

/** Haiku uses classic extended thinking, not the effort parameter. */
export function modelSupportsEffort(id: string): boolean {
  return getModels().find((m) => m.id === id)?.effort !== false && !/haiku/i.test(id)
}

export function modelName(id: string): string {
  const known = getModels().find(m => m.id === id)
  if (known) return known.name
  const raw = id.replace(/^claude-/, '').replace(/-\d{8}.*$/, '')
  const [family, ...vParts] = raw.split('-')
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${vParts.join('.')}`
}

interface Props {
  model: string
  effort: Effort
  onModelChange: (model: string) => void
  onEffortChange: (effort: Effort) => void
  disabled?: boolean
  /** 'up' opens above the button (chat input), 'down' opens below (forms) */
  direction?: 'up' | 'down'
}

export default function ModelSelector({ model, effort, onModelChange, onEffortChange, disabled, direction = 'up' }: Props) {
  const [showMenu, setShowMenu] = useState(false)
  const [hOffset, setHOffset] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const catalogue = useModelCatalogue()
  const models = useModelSearch(catalogue, model)
  const selectedModel = catalogue.find(m => m.id === model) || { id: model, name: modelName(model), desc: '' }
  const supportsEffort = modelSupportsEffort(model)
  const effortLabel = EFFORTS.find(e => e.id === effort)?.label ?? effort

  useEffect(() => {
    if (!showMenu) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMenu])

  useLayoutEffect(() => {
    if (!showMenu) {
      setHOffset(0)
      return
    }
    if (!dropdownRef.current) return
    const rect = dropdownRef.current.getBoundingClientRect()
    const margin = 8
    if (rect.left < margin) {
      setHOffset(margin - rect.left)
    } else if (rect.right > window.innerWidth - margin) {
      setHOffset(window.innerWidth - margin - rect.right)
    }
  }, [showMenu])

  const positionClass = direction === 'up'
    ? 'absolute bottom-full right-0 mb-2'
    : 'absolute top-full right-0 mt-2'

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setShowMenu(v => !v)}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium text-text-secondary bg-bg hover:bg-border/60 transition-colors disabled:opacity-30"
      >
        <span className="text-text-primary font-semibold">{selectedModel.name}</span>
        {supportsEffort && effort !== DEFAULT_EFFORT && (
          <span className="text-[10px] font-semibold text-accent">{effortLabel}</span>
        )}
        <ChevronDown size={12} className="text-text-muted" />
      </button>

      {showMenu && (
        <div
          ref={dropdownRef}
          style={{ transform: hOffset ? `translateX(${hOffset}px)` : undefined }}
          className={`${positionClass} w-72 bg-surface border border-border rounded-2xl shadow-lg overflow-hidden z-50`}
        >
          {/* Models list */}
          <div className="p-2">
            {models.searchable && (
              <input
                value={models.query}
                onChange={(e) => models.setQuery(e.target.value)}
                placeholder='Search models…'
                className='w-full mb-2 bg-bg border border-border rounded-lg px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent'
              />
            )}
            {models.visible.map((m, i) => (
              <button
                key={m.id}
                onClick={() => { onModelChange(m.id); setShowMenu(false) }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-left ${
                  model === m.id
                    ? 'bg-accent/10'
                    : 'hover:bg-bg'
                }`}
              >
                <div className="flex-1">
                  <div className={`text-sm font-semibold ${model === m.id ? 'text-accent' : 'text-text-primary'}`}>{m.name}</div>
                  <div className="text-xs text-text-muted mt-0.5">{m.desc}</div>
                </div>
                {model === m.id && <Check size={16} className="text-accent shrink-0" />}
              </button>
            ))}
            {models.hidden > 0 && (
              <p className='px-2 pt-1 text-xs text-text-muted'>
                {models.query
                  ? `+${models.hidden} more — keep typing`
                  : `${models.total} available — search to narrow`}
              </p>
            )}
            {models.total === 0 && (
              <p className='px-2 pt-1 text-xs text-text-muted'>
                No model matches “{models.query}”.
              </p>
            )}
          </div>

          <div className="h-px bg-border" />

          {/* Effort selector */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Brain size={12} className="text-text-muted" />
              <span className="text-sm font-semibold text-text-primary">Effort</span>
              {!supportsEffort && (
                <span className="text-[11px] text-text-muted">· n/a for {selectedModel.name}</span>
              )}
            </div>
            <div className={`flex gap-0.5 bg-surface2 rounded-lg p-0.5 ${!supportsEffort ? 'opacity-40 pointer-events-none' : ''}`}>
              {EFFORTS.map(e => (
                <button
                  key={e.id}
                  onClick={() => onEffortChange(e.id)}
                  title={e.hint}
                  className={`flex-1 px-2 py-1 text-xs rounded-md transition-colors ${
                    effort === e.id
                      ? 'bg-bg text-text-primary shadow-sm font-medium'
                      : 'text-text-muted hover:text-text-primary'
                  }`}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
