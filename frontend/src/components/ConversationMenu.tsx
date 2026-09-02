import {
  useState,
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { MoreHorizontal, Trash2, Bell, BellOff, BellRing, Clock, Link2, Pencil, Brain, FolderInput, RefreshCw, ExternalLink, Copy, KeyRound, Share2 } from 'lucide-react'
import { useModelCatalogue, DEFAULT_MODEL, modelName, EFFORTS, DEFAULT_EFFORT, modelSupportsEffort } from './ModelSelector'
import ShareDialog from './ShareDialog'
import type { Effort } from '../api'

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
  effort?: Effort
  onModelChange?: (model: string) => void
  onEffortChange?: (effort: Effort) => void
  conversationId?: string
  hasCron?: boolean
  hasWebhook?: boolean
  /** Opens the parent's section picker — the menu itself stays dumb, like onRename. */
  onMove?: () => void
  onRefreshApp?: () => void
  appUrl?: string
  onRotateAppToken?: () => Promise<void>
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
    model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, onModelChange, onEffortChange,
    conversationId, hasCron, hasWebhook,
    onMove,
    onRefreshApp, appUrl, onRotateAppToken,
    triggerClassName = '',
    compact = false,
  }, ref) {
    const navigate = useNavigate()
    const [open, setOpen] = useState(false)
    const [sharing, setSharing] = useState(false)
    const btnRef = useRef<HTMLButtonElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    const catalogue = useModelCatalogue()
    const selectedModel = catalogue.find(m => m.id === model)
    const shortName = selectedModel?.name ?? modelName(model ?? DEFAULT_MODEL)
    const supportsEffort = modelSupportsEffort(model ?? DEFAULT_MODEL)

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
          {!compact && supportsEffort && effort !== DEFAULT_EFFORT && <Brain size={11} className='text-accent' />}
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
                    {catalogue.map(m => (
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

                {/* Effort selector */}
                <div className='px-2 py-1.5'>
                  <span className='text-[11px] text-text-muted font-medium flex items-center gap-1'>
                    <Brain size={11} />
                    Effort
                    {!supportsEffort && <span className='opacity-70'>· n/a</span>}
                  </span>
                  <div className={`flex gap-0.5 mt-1 bg-surface2 rounded-lg p-0.5 ${!supportsEffort ? 'opacity-40 pointer-events-none' : ''}`}>
                    {EFFORTS.map(e => (
                      <button
                        key={e.id}
                        onClick={() => onEffortChange?.(e.id)}
                        title={e.hint}
                        className={`flex-1 px-1.5 py-1 text-[11px] rounded-md transition-colors ${
                          effort === e.id
                            ? 'bg-bg text-text-primary shadow-sm'
                            : 'text-text-muted hover:text-text-primary'
                        }`}
                      >
                        {e.label}
                      </button>
                    ))}
                  </div>
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
                  <>
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
                    <button
                      onClick={async () => {
                        await navigator.clipboard.writeText(
                          new URL(appUrl, window.location.origin).toString(),
                        )
                        setOpen(false)
                        window.__jarvisToast?.success('Share link copied.')
                      }}
                      className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
                    >
                      <Copy size={14} />
                      Copy share link
                    </button>
                    <button
                      onClick={async () => {
                        // Anyone still holding the old link loses access, so
                        // make that consequence explicit before doing it.
                        if (!confirm(
                          'Generate a new share link?\n\nThe current link will stop working for anyone you gave it to.',
                        )) return
                        setOpen(false)
                        try {
                          await onRotateAppToken?.()
                          window.__jarvisToast?.success('New share link generated. The old one no longer works.')
                        } catch {
                          window.__jarvisToast?.error("Couldn't generate a new link.")
                        }
                      }}
                      className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
                    >
                      <KeyRound size={14} />
                      New share link
                    </button>
                  </>
                )}
                <div className='h-px bg-border my-1' />
              </>
            )}

            {conversationId && (
              <button
                onClick={() => { setOpen(false); setSharing(true) }}
                className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
              >
                <Share2 size={14} />
                Share conversation
              </button>
            )}

            {onMove && (
              <button
                onClick={() => { setOpen(false); onMove() }}
                className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg whitespace-nowrap'
              >
                <FolderInput size={14} />
                Move to section
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

        {sharing && conversationId && (
          <ShareDialog
            conversationId={conversationId}
            onClose={() => setSharing(false)}
          />
        )}
      </div>
    )
  },
)

export default ConversationMenu
