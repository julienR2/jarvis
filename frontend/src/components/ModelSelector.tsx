import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight, Check } from 'lucide-react'

export interface ModelOption {
  id: string
  name: string
  desc: string
}

export const MODELS: ModelOption[] = [
  { id: 'claude-opus-4-6', name: 'Opus 4.6', desc: 'Most capable for ambitious work' },
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', desc: 'Balanced speed and intelligence' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', desc: 'Fastest, most compact' },
]

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

interface Props {
  model: string
  thinking: boolean
  onModelChange: (model: string) => void
  onThinkingChange: (thinking: boolean) => void
  disabled?: boolean
  /** 'up' opens above the button (chat input), 'down' opens below (forms) */
  direction?: 'up' | 'down'
}

export default function ModelSelector({ model, thinking, onModelChange, onThinkingChange, disabled, direction = 'up' }: Props) {
  const [showMenu, setShowMenu] = useState(false)
  const [showMoreModels, setShowMoreModels] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const selectedModel = MODELS.find(m => m.id === model) || MODELS[0]

  useEffect(() => {
    if (!showMenu) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
        setShowMoreModels(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMenu])

  const positionClass = direction === 'up'
    ? 'absolute bottom-full right-0 mb-2'
    : 'absolute top-full right-0 mt-2'

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => { setShowMenu(v => !v); setShowMoreModels(false) }}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium text-text-secondary bg-bg hover:bg-border/60 transition-colors disabled:opacity-30"
      >
        <span className="text-text-primary font-semibold">{selectedModel.name}</span>
        {thinking && <span className="text-text-muted">Extended</span>}
        <ChevronDown size={12} className="text-text-muted" />
      </button>

      {showMenu && (
        <div className={`${positionClass} w-72 bg-surface border border-border rounded-2xl shadow-lg overflow-hidden z-50`}>
          {/* Primary model (Sonnet 4.6) */}
          <button
            onClick={() => { onModelChange('claude-sonnet-4-6'); setShowMoreModels(false) }}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg transition-colors text-left"
          >
            <div>
              <div className="text-sm font-semibold text-text-primary">Sonnet 4.6</div>
              <div className="text-xs text-text-muted mt-0.5">Balanced speed and intelligence</div>
            </div>
            {model === 'claude-sonnet-4-6' && <Check size={16} className="text-accent shrink-0" />}
          </button>

          <div className="h-px bg-border" />

          {/* Extended thinking toggle */}
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-text-primary">Extended thinking</div>
              <div className="text-xs text-text-muted mt-0.5">Think longer for complex tasks</div>
            </div>
            <button
              onClick={() => onThinkingChange(!thinking)}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${thinking ? 'bg-accent' : 'bg-border'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${thinking ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          <div className="h-px bg-border" />

          {/* More models */}
          {!showMoreModels ? (
            <button
              onClick={() => setShowMoreModels(true)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg transition-colors text-left"
            >
              <span className="text-sm font-semibold text-text-primary">More models</span>
              <ChevronRight size={16} className="text-text-muted" />
            </button>
          ) : (
            MODELS.filter(m => m.id !== 'claude-sonnet-4-6').map((m, i, arr) => (
              <div key={m.id}>
                <button
                  onClick={() => { onModelChange(m.id); setShowMenu(false); setShowMoreModels(false) }}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg transition-colors text-left"
                >
                  <div>
                    <div className="text-sm font-semibold text-text-primary">{m.name}</div>
                    <div className="text-xs text-text-muted mt-0.5">{m.desc}</div>
                  </div>
                  {model === m.id && <Check size={16} className="text-accent shrink-0" />}
                </button>
                {i < arr.length - 1 && <div className="h-px bg-border" />}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
