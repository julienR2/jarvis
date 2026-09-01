import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Send, Loader2 } from 'lucide-react'
import MessageBubble from '../components/MessageBubble'
import { getSharedConversation, connectSharedEvents, sendSharedMessage } from '../api'
import type { Message, SharedConversation } from '../api'

/**
 * The read-only / editable view of a shared conversation.
 *
 * Deliberately not ChatView: a visitor gets the title, the transcript, the app
 * if there is one, and — on a 'write' link — a plain composer. No sidebar, no
 * conversation menu, no model or effort controls, no rename/delete. Those act
 * on the owner's instance, so they aren't hidden here, they're absent.
 */
export default function SharedChatPage() {
  const { token = '' } = useParams()
  const [conv, setConv] = useState<SharedConversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [thinking, setThinking] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    getSharedConversation(token)
      .then((data) => {
        if (cancelled) return
        setConv(data)
        setMessages(data.messages)
      })
      .catch(() => {
        if (!cancelled) setError('This link is no longer valid.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  // Live updates, so a shared chat isn't a stale snapshot while the owner (or a
  // visitor on a write link) is mid-conversation.
  useEffect(() => {
    if (!conv) return
    const conn = connectSharedEvents(token, (ev) => {
      if (ev.type === 'message') {
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === ev.message.id)
          if (i === -1) return [...prev, ev.message]
          const next = [...prev]
          next[i] = ev.message
          return next
        })
      } else if (ev.type === 'thinking') {
        setThinking(ev.thinking)
      }
    })
    return () => conn.close()
  }, [conv, token])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, thinking])

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await sendSharedMessage(token, text)
      setInput('')
    } catch (err: any) {
      setError(err.message || 'Could not send.')
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <div className='h-screen w-full bg-bg flex items-center justify-center text-text-muted'>
        <Loader2 size={20} className='animate-spin' />
      </div>
    )
  }

  if (error && !conv) {
    return (
      <div className='h-screen w-full bg-bg flex items-center justify-center px-6'>
        <p className='text-text-muted text-sm text-center'>{error}</p>
      </div>
    )
  }

  const canWrite = conv?.mode === 'write'

  return (
    <div className='h-screen w-full bg-bg flex flex-col'>
      {/* Title only — no sidebar toggle, no menu. */}
      <div className='shrink-0 border-b border-border'>
        <div className='flex items-center gap-2 h-12 px-4 md:px-6 max-w-3xl mx-auto w-full'>
          <h1 className='text-sm font-medium text-text-primary truncate flex-1'>
            {conv?.title}
          </h1>
          <span className='text-xs text-text-muted shrink-0'>
            {canWrite ? 'Shared · can reply' : 'Shared · read-only'}
          </span>
        </div>
      </div>

      <div className='flex-1 overflow-hidden flex flex-col md:flex-row'>
        <div className='flex-1 overflow-y-auto'>
          <div className='max-w-3xl mx-auto px-4 md:px-6 py-6'>
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            {thinking && (
              <div className='flex items-center gap-2 text-text-muted text-sm py-2'>
                <Loader2 size={14} className='animate-spin' />
                Working…
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {conv?.app_url && (
          <div className='md:w-1/2 md:border-l border-t md:border-t-0 border-border h-1/2 md:h-auto'>
            <iframe
              src={conv.app_url}
              title='App'
              className='w-full h-full bg-white'
              sandbox='allow-scripts allow-same-origin allow-forms allow-popups allow-modals'
            />
          </div>
        )}
      </div>

      {canWrite && (
        <div className='shrink-0 border-t border-border'>
          <div className='max-w-3xl mx-auto px-4 md:px-6 py-3 flex items-end gap-2'>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              rows={1}
              placeholder='Reply…'
              className='flex-1 resize-none bg-surface border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm focus:border-accent outline-none max-h-40'
            />
            <button
              onClick={send}
              disabled={!input.trim() || sending}
              className='bg-accent text-white p-2.5 rounded-xl hover:bg-accent-hover disabled:opacity-50 transition-colors'
              aria-label='Send'
            >
              {sending ? <Loader2 size={16} className='animate-spin' /> : <Send size={16} />}
            </button>
          </div>
          {error && (
            <p className='max-w-3xl mx-auto px-4 md:px-6 pb-2 text-xs text-danger'>{error}</p>
          )}
        </div>
      )}
    </div>
  )
}
