import {
  useState,
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { MoreHorizontal, Trash2, Bell, BellOff, BellRing, Clock, Link2, Pencil, Brain, Pin, PinOff, RefreshCw, ExternalLink } from 'lucide-react'
import { MODELS, DEFAULT_MODEL } from './ModelSelector'

type NotifyMode = 'subscribe' | 'unsubscribe' | 'auto'

const NOTIFY_OPTIONS: { value: NotifyMode; label: string; icon: typeof Bell }[] = [
  { value: 'subscribe', label: 'Always', icon: Bell },
  { value: 'unsubscribe', label: 'Never', icon: BellOff },
  { value: 'auto', label: 'Auto', icon: BellRing },
]

interface Props {
  onDelete: () => void
  onRename?: () => void
  notify?: NotifyMode
  onNotifyChange?: (mode: NotifyMode) => void
  model?: string
  thinking?: boolean
  onModelChange?: (model: string) => void
  onThinkingChange?: (thinking: boolean) => void
  conversationId?: string
  hasCron?: boolean
  hasWebhook?: boolean
  pinned?: boolean
  onPinChange?: (pinned: boolean) => void
  onRefreshApp?: () => void
  appUrl?: string
  /** Extra classes for the trigger button */
  triggerClassName?: string
  /** Sidebar mode: only show ⋯ trigger and Edit/Delete in dropdown */
  compact?: boolean
}

export interface ConversationMenuHandle {
  open(): void
}

const ConversationMenu = forwardRef<ConversationMenuHandle, Props>(
  function ConversationMenu({
    onDelete, onRename,
    notify = 'subscribe', onNotifyChange,
    model = DEFAULT_MODEL, thinking = false, onModelChange, onThinkingChange,
    conversationId, hasCron, hasWebhook,
    pinned = false, onPinChange,
    onRefreshApp, appUrl,
    triggerClassName = '',
    compact = false,
  }, ref) {
    const navigate = useNavigate()
    const [open, setOpen] = useState(false)
    const btnRef = useRef<HTMLButtonElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    const selectedModel = MODELS.find(m => m.id === model) || MODELS[0]
    const shortName = selectedModel.name

    useImperativeHandle(ref, () => ({
      open() { setOpen(true) },
    }))

    const handleOutside = useCallback((e: MouseEvent | TouchEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }, [])

    useEffect(() => {
      if (!open) return
      window.addEventListener('click', handleOutside)
      window.addEventListener('touchstart', handleOutside)
      return () => {
        window.removeEventListener('click', handleOutside)
        window.removeEventListener('touchstart', handleOutside)
      }
    }, [open, handleOutside])

    return (
      <div ref={containerRef} className={`relative items-center ${triggerClassName || 'flex'} ${open ? '!flex' : ''}`}>
        <button
          ref={btnRef}
          onClick={() => setOpen(o => !o)}
          className={`flex items-center gap-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors shrink-0 ${compact ? 'px-1.5 py-0.5' : 'px-2 py-1'} ${open ? 'bg-surface2 text-text-primary' : ''}`}
          title='Conversation options'
        >
          {!compact && <span className='text-xs font-medium text-text-secondary'>{shortName}</span>}
          {!compact && thinking && <Brain size={11} className='text-accent' />}
          <MoreHorizontal size={14} />
        </button>

        {open && (
          <div onClick={(e) => e.stopPropagation()} className='absolute right-0 top-full mt-1 z-[200] min-w-[150px] bg-surface border border-border rounded-xl shadow-md/5 p-1 overflow-hidden'>

            {!compact && (
              <>
                {/* Model selector */}
                <div className='px-2 py-1.5'>
                  <span className='text-[11px] text-text-muted font-medium'>Model</span>
                  <div className='flex flex-col gap-0.5 mt-1'>
                    {MODELS.map(m => (
                      <button
                        key={m.id}
                        onClick={() => onModelChange?.(m.id)}
                        className={`w-full text-left px-2 py-1.5 text-xs rounded-md transition-colors ${
                          model === m.id
                            ? 'bg-accent/10 text-accent font-medium'
                            : 'text-text-secondary hover:bg-surface2 hover:text-text-primary'
                        }`}
                        title={m.desc}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Extended thinking toggle */}
                <div className='flex items-center justify-between px-2 py-1.5'>
                  <span className='text-[11px] text-text-muted font-medium flex items-center gap-1'>
                    <Brain size={11} />
                    Extended thinking
                  </span>
                  <button
                    onClick={() => onThinkingChange?.(!thinking)}
                    className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${thinking ? 'bg-accent' : 'bg-border'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform ${thinking ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                </div>

                <div className='h-px bg-border my-1' />

                {/* Notify toggle */}
                <div className='px-2 py-1.5'>
                  <span className='text-[11px] text-text-muted font-medium'>Notifications</span>
                  <div className='flex gap-0.5 mt-1 bg-surface2 rounded-lg p-0.5'>
                    {NOTIFY_OPTIONS.map(({ value, label, icon: Icon }) => (
                      <button
                        key={value}
                        onClick={() => onNotifyChange?.(value)}
                        className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[11px] rounded-md transition-colors ${
                          notify === value
                            ? 'bg-bg text-text-primary shadow-sm'
                            : 'text-text-muted hover:text-text-primary'
                        }`}
                        title={`Notifications: ${label}`}
                      >
                        <Icon size={11} />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {(hasCron || hasWebhook) && (
                  <>
                    <div className='h-px bg-border my-1' />
                    {hasCron && (
                      <button
                        onClick={() => { setOpen(false); navigate(`/crons?conversation_id=${conversationId}`) }}
                        className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
                      >
                        <Clock size={14} />
                        View crons
                      </button>
                    )}
                    {hasWebhook && (
                      <button
                        onClick={() => { setOpen(false); navigate(`/webhooks?conversation_id=${conversationId}`) }}
                        className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
                      >
                        <Link2 size={14} />
                        View webhooks
                      </button>
                    )}
                  </>
                )}

                <div className='h-px bg-border my-1' />
              </>
            )}

            {onRefreshApp && (
              <>
                <button
                  onClick={() => { setOpen(false); onRefreshApp() }}
                  className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
                >
                  <RefreshCw size={14} />
                  Refresh preview
                </button>
                {appUrl && (
                  <a
                    href={appUrl}
                    target='_blank'
                    rel='noopener noreferrer'
                    onClick={() => setOpen(false)}
                    className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
                  >
                    <ExternalLink size={14} />
                    Open in new tab
                  </a>
                )}
                <div className='h-px bg-border my-1' />
              </>
            )}

            {onPinChange && (
              <button
                onClick={() => { setOpen(false); onPinChange(!pinned) }}
                className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
              >
                {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                {pinned ? 'Unpin' : 'Pin'}
              </button>
            )}

            <button
              onClick={() => { setOpen(false); onRename?.() }}
              className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
            >
              <Pencil size={14} />
              Edit name
            </button>

            <button
              onClick={() => {
                setOpen(false)
                if (confirm('Delete this conversation?')) onDelete()
              }}
              className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-danger hover:bg-surface2 transition-colors rounded-lg'
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        )}
      </div>
    )
  },
)

export default ConversationMenu
