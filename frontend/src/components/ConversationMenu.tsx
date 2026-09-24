import { useState, useRef, forwardRef, useImperativeHandle } from 'react'
import { useNavigate } from 'react-router-dom'
import { MoreHorizontal, Trash2, Bell, BellOff, BellRing, Repeat, Pencil, FolderInput, RefreshCw, ExternalLink, Copy, KeyRound, Share2 } from 'lucide-react'
import Popover from './Popover'
import ShareDialog from './ShareDialog'
import DeleteConversationDialog from './DeleteConversationDialog'
import type { DeleteOptions } from '../api'

type NotifyMode = 'subscribe' | 'unsubscribe' | 'auto'

const NOTIFY_OPTIONS: { value: NotifyMode; label: string; icon: typeof Bell }[] = [
  { value: 'subscribe', label: 'Always', icon: Bell },
  { value: 'unsubscribe', label: 'Never', icon: BellOff },
  { value: 'auto', label: 'Auto', icon: BellRing },
]

interface Props {
  onDelete: (opts: DeleteOptions) => void
  onRename?: () => void
  notify?: NotifyMode
  onNotifyChange?: (mode: NotifyMode) => void
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
    conversationId, hasCron, hasWebhook,
    onMove,
    onRefreshApp, appUrl, onRotateAppToken,
    triggerClassName = '',
    compact = false,
  }, ref) {
    const navigate = useNavigate()
    const [open, setOpen] = useState(false)
    const [sharing, setSharing] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const btnRef = useRef<HTMLButtonElement>(null)

    useImperativeHandle(ref, () => ({
      open() { setOpen(true) },
    }))

    return (
      <div className={`relative items-center ${triggerClassName || 'flex'} ${open ? '!flex' : ''}`}>
        <button
          ref={btnRef}
          onClick={() => setOpen(o => !o)}
          className={`flex items-center gap-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors shrink-0 ${compact ? 'px-1.5 py-0.5' : 'px-2 py-1'} ${open ? 'bg-surface2 text-text-primary' : ''}`}
          title='Conversation options'
        >
          <MoreHorizontal size={14} />
        </button>

        <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} className='min-w-[150px] bg-surface border border-border rounded-xl shadow-md/5 p-1'>
          {/* The panel is portalled, but React events still bubble to the row
              that rendered it — a click here must not also open the chat. */}
          <div onClick={(e) => e.stopPropagation()}>

            {!compact && (
              <>
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

                <div className='h-px bg-border my-1' />
                <button
                  onClick={() => { setOpen(false); navigate(`/routines?conversation_id=${conversationId}`) }}
                  className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-text-secondary hover:bg-surface2 transition-colors rounded-lg'
                >
                  <Repeat size={14} />
                  Routines{(hasCron || hasWebhook) ? '' : ' (none yet)'}
                </button>

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

            {/* Sharing belongs to the chat's own title bar, not the sidebar's
                short menu (the id is passed there for the delete dialog). */}
            {conversationId && !compact && (
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
                Move to topic
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
                // What goes with the chat — files, routines — is asked, not assumed.
                setDeleting(true)
              }}
              className='w-full flex items-center gap-2.5 px-2 py-1.5 text-sm text-danger hover:bg-surface2 transition-colors rounded-lg'
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </Popover>

        {sharing && conversationId && (
          <ShareDialog
            conversationId={conversationId}
            onClose={() => setSharing(false)}
          />
        )}
        {deleting && (
          <DeleteConversationDialog
            conversationId={conversationId}
            onConfirm={(opts) => { setDeleting(false); onDelete(opts) }}
            onClose={() => setDeleting(false)}
          />
        )}
      </div>
    )
  },
)

export default ConversationMenu
