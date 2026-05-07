import {
  useState,
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { MoreHorizontal, Trash2, Bell, BellOff, BellRing, Clock, Link2, Pencil } from 'lucide-react'

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
  conversationId?: string
  hasCron?: boolean
  hasWebhook?: boolean
  /** Extra classes for the trigger button */
  triggerClassName?: string
}

export interface ConversationMenuHandle {
  open(): void
}

const ConversationMenu = forwardRef<ConversationMenuHandle, Props>(
  function ConversationMenu({ onDelete, onRename, notify = 'subscribe', onNotifyChange, conversationId, hasCron, hasWebhook, triggerClassName = '' }, ref) {
    const navigate = useNavigate()
    const [open, setOpen] = useState(false)
    const btnRef = useRef<HTMLButtonElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    useImperativeHandle(ref, () => ({
      open() {
        setOpen(true)
      },
    }))

    function handleTriggerClick() {
      setOpen((o) => !o)
    }

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
      <div ref={containerRef} className='relative flex items-center'>
        <button
          ref={btnRef}
          onClick={handleTriggerClick}
          className={`rounded text-text-muted hover:text-text-primary transition-colors shrink-0 ${triggerClassName} ${open ? '!flex' : ''}`}
          title='More options'
        >
          <MoreHorizontal size={14} />
        </button>

        {open && (
          <div className='absolute right-0 top-full mt-1 z-[200] min-w-[170px] bg-surface border border-border rounded-xl shadow-md/5 p-1 overflow-hidden'>
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
                    className='w-full flex items-center gap-2.5 px-2 py-1 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
                  >
                    <Clock size={14} />
                    View crons
                  </button>
                )}
                {hasWebhook && (
                  <button
                    onClick={() => { setOpen(false); navigate(`/webhooks?conversation_id=${conversationId}`) }}
                    className='w-full flex items-center gap-2.5 px-2 py-1 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
                  >
                    <Link2 size={14} />
                    View webhooks
                  </button>
                )}
              </>
            )}

            <div className='h-px bg-border my-1' />

            <button
              onClick={() => { setOpen(false); onRename?.() }}
              className='w-full flex items-center gap-2.5 px-2 py-1 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
            >
              <Pencil size={14} />
              Edit name
            </button>

            <button
              onClick={() => {
                setOpen(false)
                if (confirm('Delete this conversation?')) onDelete()
              }}
              className='w-full flex items-center gap-2.5 px-2 py-1 text-sm text-danger hover:bg-surface2 transition-colors rounded-lg'
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
