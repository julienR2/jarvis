import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Copy, Check, Loader2, Eye, MessageSquare, Link2Off } from 'lucide-react'
import { api } from '../api'
import { useChatStore } from '../stores/chatStore'

type Mode = 'read' | 'write' | null

/**
 * Owner-side controls for sharing a conversation.
 *
 * 'write' is the one that needs care: it lets anyone holding the link run the
 * owner's agent on their own budget, so the consequence is stated next to the
 * option rather than buried.
 */
export default function ShareDialog({
  conversationId,
  onClose,
}: {
  conversationId: string
  onClose: () => void
}) {
  const [mode, setMode] = useState<Mode>(null)
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getShare(conversationId)
      .then((s) => {
        setMode(s.mode)
        setToken(s.token)
        useChatStore.getState().setShareMode(conversationId, s.mode)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [conversationId])

  const url = token ? `${window.location.origin}/s/${token}` : ''

  async function apply(next: Mode, rotate = false) {
    setBusy(true)
    setError('')
    try {
      const s = await api.setShare(conversationId, next, rotate)
      setMode(s.mode)
      setToken(s.token)
      useChatStore.getState().setShareMode(conversationId, s.mode)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className='fixed inset-0 z-[500] bg-black/50 flex items-center justify-center p-4'
      onClick={onClose}
    >
      <div
        className='bg-surface border border-border rounded-2xl shadow-xl w-full max-w-md p-5'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex items-center mb-1'>
          <h2 className='text-base font-semibold text-text-primary flex-1'>
            Share conversation
          </h2>
          <button onClick={onClose} className='text-text-muted hover:text-text-primary p-1'>
            <X size={16} />
          </button>
        </div>
        <p className='text-sm text-text-muted mb-4'>
          Anyone with the link can open this conversation — no account needed.
        </p>

        {loading ? (
          <div className='flex justify-center py-6 text-text-muted'>
            <Loader2 size={18} className='animate-spin' />
          </div>
        ) : (
          <>
            <div className='flex flex-col gap-2 mb-4'>
              <ModeOption
                icon={<Eye size={16} />}
                label='Read-only'
                detail='They can read the conversation as it continues.'
                active={mode === 'read'}
                disabled={busy}
                onClick={() => apply('read')}
              />
              <ModeOption
                icon={<MessageSquare size={16} />}
                label='Can reply'
                detail='They can also send messages, which run on your instance and your Claude usage.'
                active={mode === 'write'}
                disabled={busy}
                onClick={() => apply('write')}
              />
              <ModeOption
                icon={<Link2Off size={16} />}
                label='Not shared'
                detail='Turns the link off. Sharing again creates a new one.'
                active={mode === null}
                disabled={busy}
                onClick={() => apply(null)}
              />
            </div>

            {mode && token && (
              <div className='flex flex-col gap-2'>
                <div className='flex gap-2'>
                  <input
                    readOnly
                    value={url}
                    onFocus={(e) => e.currentTarget.select()}
                    className='flex-1 bg-bg border border-border text-text-primary rounded-xl px-3 py-2 text-xs font-mono outline-none'
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(url)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                    className='bg-accent text-white px-3 rounded-xl hover:bg-accent-hover transition-colors'
                    aria-label='Copy link'
                  >
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                </div>
                <button
                  onClick={() => {
                    if (!confirm('Generate a new link?\n\nThe current one will stop working for everyone you gave it to.')) return
                    apply(mode, true)
                  }}
                  disabled={busy}
                  className='text-xs text-text-muted hover:text-text-primary self-start transition-colors'
                >
                  Generate a new link
                </button>
              </div>
            )}

            {error && <p className='text-danger text-sm mt-3'>{error}</p>}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function ModeOption({
  icon, label, detail, active, disabled, onClick,
}: {
  icon: React.ReactNode
  label: string
  detail: string
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-left rounded-xl border px-3.5 py-2.5 transition-colors disabled:opacity-60 ${
        active
          ? 'border-accent bg-accent-subtle'
          : 'border-border bg-bg hover:border-text-muted'
      }`}
    >
      <span className='flex items-center gap-2 text-sm font-medium text-text-primary'>
        {icon}
        {label}
      </span>
      <span className='block text-xs text-text-muted mt-0.5'>{detail}</span>
    </button>
  )
}
