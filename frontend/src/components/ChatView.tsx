import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { Clock, Link2, BellOff, BellRing } from 'lucide-react'
import {
  api,
  connectEvents,
  type Message,
  type Attachment,
  type ChatEvent,
  type Conversation,
} from '../api'

// Module-level SWR cache — persists across route changes, cleared only on delete
type CachedConv = { messages: Message[]; title: string; hasMiniApp: boolean; notify: Conversation['notify']; hasCron: boolean; hasWebhook: boolean }
const convCache = new Map<string, CachedConv>()

export function invalidateConvCache(id: string) {
  convCache.delete(id)
}
import MessageBubble from './MessageBubble'
import ChatInput from './ChatInput'
import MiniAppPreview from './MiniAppPreview'
import { ContentTitle } from './ContentLayout'
import ConversationMenu from './ConversationMenu'

interface Props {
  onTitleChange: (id: string, title: string) => void
  onRefreshList: () => void
  onDelete?: (id: string) => void
  initialMessage?: string | null
  onInitialMessageConsumed?: () => void
  initialFiles?: File[] | null
  onInitialFilesConsumed?: () => void
}

export default function ChatView({
  onTitleChange,
  onRefreshList,
  onDelete,
  initialMessage,
  onInitialMessageConsumed,
  initialFiles,
  onInitialFilesConsumed,
}: Props) {
  const { id: conversationId } = useParams<{ id: string }>()
  const [messages, setMessages] = useState<Message[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [hasMiniApp, setHasMiniApp] = useState(false)
  const [notify, setNotify] = useState<Conversation['notify']>('subscribe')
  const [hasCron, setHasCron] = useState(false)
  const [hasWebhook, setHasWebhook] = useState(false)
  const [miniAppRefreshKey, setMiniAppRefreshKey] = useState(0)
  const [showPreview, setShowPreview] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null)
  const [showFloating, setShowFloating] = useState(false)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const convIdRef = useRef(conversationId)
  const onTitleChangeRef = useRef(onTitleChange)
  const onRefreshListRef = useRef(onRefreshList)
  useEffect(() => {
    convIdRef.current = conversationId
  }, [conversationId])
  useEffect(() => {
    onTitleChangeRef.current = onTitleChange
  }, [onTitleChange])
  useEffect(() => {
    onRefreshListRef.current = onRefreshList
  }, [onRefreshList])

  const handleEvent = useCallback((ev: ChatEvent) => {
    const cid = convIdRef.current
    switch (ev.type) {
      case 'message': {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === ev.message.id)
          if (idx >= 0) {
            return prev.map((m, i) => (i === idx ? ev.message : m))
          }
          return [...prev, ev.message]
        })
        break
      }

      case 'conversation': {
        if (ev.title && cid) {
          setTitle(ev.title)
          onTitleChangeRef.current(cid, ev.title)
          onRefreshListRef.current()
        }
        break
      }

      case 'thinking': {
        setIsProcessing(ev.thinking)
        break
      }

      case 'mini_app_updated':
        setHasMiniApp(true)
        setMiniAppRefreshKey((k) => k + 1)
        onRefreshListRef.current()
        break
    }
  }, [])

  useEffect(() => {
    if (!conversationId) return
    setIsProcessing(false)
    setShowPreview(true)

    // Show cached data immediately (no skeleton), or show skeleton on first visit
    const cached = convCache.get(conversationId)
    if (cached) {
      setMessages(cached.messages)
      setTitle(cached.title)
      setHasMiniApp(cached.hasMiniApp)
      setNotify(cached.notify)
      setHasCron(cached.hasCron)
      setHasWebhook(cached.hasWebhook)
      setLoading(false)
    } else {
      setMessages([])
      setTitle('')
      setHasMiniApp(false)
      setNotify('subscribe')
      setHasCron(false)
      setHasWebhook(false)
      setLoading(true)
    }

    // Always fetch in background to pick up new messages
    api.getConversation(conversationId).then((conv) => {
      convCache.set(conversationId, {
        messages: conv.messages,
        title: conv.title,
        hasMiniApp: !!conv.mini_app_path,
        notify: conv.notify,
        hasCron: !!conv.has_cron,
        hasWebhook: !!conv.has_webhook,
      })
      setMessages(conv.messages)
      setTitle(conv.title)
      setHasMiniApp(!!conv.mini_app_path)
      setNotify(conv.notify)
      setHasCron(!!conv.has_cron)
      setHasWebhook(!!conv.has_webhook)
      setLoading(false)
    })

    let wasConnected = false
    const conn = connectEvents(conversationId, handleEvent, (status) => {
      if (status && wasConnected) {
        // Reconnected — merge silently, no skeleton, no layout shift
        api.getConversation(conversationId).then((conv) => {
          convCache.set(conversationId, {
            messages: conv.messages,
            title: conv.title,
            hasMiniApp: !!conv.mini_app_path,
            notify: conv.notify,
            hasCron: !!conv.has_cron,
            hasWebhook: !!conv.has_webhook,
          })
          setMessages((prev) => mergeMessages(prev, conv.messages))
          setTitle(conv.title)
          setHasMiniApp(!!conv.mini_app_path)
          setNotify(conv.notify)
          setHasCron(!!conv.has_cron)
          setHasWebhook(!!conv.has_webhook)
          setIsProcessing(false)
        })
      }
      wasConnected = true
    })

    return () => conn.close()
  }, [conversationId, handleEvent])

  // Consume initial message once passed to input
  const initialConsumedRef = useRef(false)
  useEffect(() => {
    initialConsumedRef.current = false
  }, [conversationId])
  useEffect(() => {
    if (initialMessage && !initialConsumedRef.current) {
      initialConsumedRef.current = true
      // Defer consumption so ChatInput picks it up first
      setTimeout(() => onInitialMessageConsumed?.(), 0)
    }
  }, [initialMessage])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isProcessing])

  useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current) }, [])

  function sendMessage(text: string, attachments: Attachment[] = [], model?: string, thinking?: boolean) {
    if (!text.trim() && attachments.length === 0) return
    if (!conversationId) return

    api
      .sendMessage(
        conversationId,
        text,
        attachments.length > 0 ? attachments : undefined,
        model,
        thinking,
      )
      .catch((err) => {
        console.error('Failed to send message:', err)
      })
  }

  async function sendAudio(audioBlob: Blob) {
    if (!conversationId) return undefined
    const res = await api.sendAudio(conversationId, audioBlob)
    return res
  }

  function handleNotifyChange(mode: Conversation['notify']) {
    if (!conversationId) return
    setNotify(mode)
    const cached = convCache.get(conversationId)
    if (cached) convCache.set(conversationId, { ...cached, notify: mode })
    api.updateConversation(conversationId, { notify: mode }).catch((err) => {
      console.error('Failed to update notify:', err)
    })
  }

  function startRename() {
    setRenameValue(title)
    setRenaming(true)
  }

  async function submitRename() {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== title && conversationId) {
      await api.updateConversation(conversationId, { title: trimmed })
      setTitle(trimmed)
      onTitleChange(conversationId, trimmed)
    }
    setRenaming(false)
  }

  function cancelMessage() {
    if (!conversationId) return
    api.cancelMessage(conversationId).catch((err) => {
      console.error('Failed to cancel:', err)
    })
  }

  function handleScroll() {
    const container = scrollContainerRef.current
    if (!container) return

    const containerTop = container.getBoundingClientRect().top
    const separators = container.querySelectorAll<HTMLElement>('[data-date-label]')

    let current: string | null = null
    for (const sep of separators) {
      if (sep.getBoundingClientRect().top <= containerTop + 8) {
        current = sep.dataset.dateLabel || null
      }
    }

    if (current) {
      setFloatingLabel(current)
      setShowFloating(true)
    }

    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setShowFloating(false), 1200)
  }

  return (
    <>
    {renaming && createPortal(
      <div
        className='fixed inset-0 z-[300] flex items-center justify-center bg-black/40'
        onClick={() => setRenaming(false)}
      >
        <div
          className='bg-surface border border-border rounded-xl p-4 w-72 shadow-lg'
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className='text-sm font-medium text-text-primary mb-3'>Edit name</h3>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            className='w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm text-text-primary focus:outline-none focus:border-accent'
          />
          <div className='flex justify-end gap-2 mt-3'>
            <button
              onClick={() => setRenaming(false)}
              className='px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors'
            >
              Cancel
            </button>
            <button
              onClick={submitRename}
              className='px-3 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors'
            >
              Save
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )}
    <div className='flex flex-col h-full'>
      {/* Mobile title bar + toggle — above both panes */}
      {title && (
        <div className='md:hidden'>
          <ContentTitle
            action={onDelete && conversationId ? (
              <span className='flex items-center gap-2'>
                <ConvStatusIcons conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} notify={notify} />
                <ConversationMenu onDelete={() => onDelete(conversationId)} onRename={startRename} notify={notify} onNotifyChange={handleNotifyChange} conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} />
              </span>
            ) : undefined}
          >
            <span className='flex items-center gap-3'>
              <span className='truncate flex-1'>{title}</span>
              {hasMiniApp && (
                <span className='flex bg-surface2 rounded-lg p-0.5 shrink-0'>
                  <button
                    onClick={() => setShowPreview(false)}
                    className={`px-3 py-1 text-xs rounded-md transition-colors ${!showPreview ? 'bg-bg text-text-primary shadow-sm' : 'text-text-muted'}`}
                  >
                    Chat
                  </button>
                  <button
                    onClick={() => setShowPreview(true)}
                    className={`px-3 py-1 text-xs rounded-md transition-colors ${showPreview ? 'bg-bg text-text-primary shadow-sm' : 'text-text-muted'}`}
                  >
                    Preview
                  </button>
                </span>
              )}
            </span>
          </ContentTitle>
        </div>
      )}

      {/* Panes */}
      <div className='flex flex-1 min-h-0'>
        {/* Chat pane */}
        <div
          className={`flex flex-col h-full ${hasMiniApp ? 'md:w-3/5 md:border-r md:border-border' : 'w-full'} ${hasMiniApp && showPreview ? 'hidden md:flex' : 'flex w-full'}`}
        >
          {/* Desktop title — inside chat pane so preview gets full height */}
          {title && (
            <div className='hidden md:block'>
              <ContentTitle
                action={onDelete && conversationId ? (
                  <span className='flex items-center gap-3'>
                    <ConvStatusIcons conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} notify={notify} />
                    <ConversationMenu onDelete={() => onDelete(conversationId)} onRename={startRename} notify={notify} onNotifyChange={handleNotifyChange} conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} />
                  </span>
                ) : undefined}
              >
                {title}
              </ContentTitle>
            </div>
          )}

          {/* Messages */}
          <div className='relative flex-1 min-h-0'>
            {/* Floating date pill */}
            <div
              className={`absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none transition-opacity duration-300 ${showFloating && floatingLabel ? 'opacity-100' : 'opacity-0'}`}
            >
              <span className='px-3 py-1 rounded-full bg-bg-alt text-[11px] text-text-muted font-medium border border-border shadow-sm'>
                {floatingLabel}
              </span>
            </div>

            <div ref={scrollContainerRef} className={`h-full overflow-y-auto overflow-x-hidden flex flex-col-reverse pb-6 ${messages.length === 0 ? 'pt-4' : 'pt-0'}`} onScroll={handleScroll}>
              <div className='max-w-3xl mx-auto px-4 md:px-6 min-w-0 w-full'>
                {loading ? (
                  <MessageSkeleton />
                ) : (
                  <>
                    {groupMessagesByDay(messages).map((item) =>
                      item.type === 'separator' ? (
                        <DateSeparator key={item.key} label={item.label} />
                      ) : (
                        <MessageBubble key={item.msg.id} msg={item.msg} />
                      ),
                    )}
                    <JarvisIndicator isThinking={isProcessing} />
                  </>
                )}
                <div ref={bottomRef} />
              </div>
            </div>
          </div>

          {/* Input */}
          <ChatInput
            onSend={sendMessage}
            onSendAudio={sendAudio}
            onCancel={cancelMessage}
            isProcessing={isProcessing}
            autoFocus={!loading && messages.length === 0}
            initialText={initialMessage || undefined}
            initialFiles={initialFiles || undefined}
            onInitialFilesConsumed={onInitialFilesConsumed}
          />
        </div>

        {/* Preview pane */}
        {hasMiniApp && (
          <div
            className={`${showPreview ? 'flex' : 'hidden md:flex'} flex-col h-full ${showPreview ? 'w-full' : ''} md:w-2/5`}
          >
            <MiniAppPreview
              conversationId={conversationId!}
              refreshKey={miniAppRefreshKey}
              onRefresh={() => setMiniAppRefreshKey((k) => k + 1)}
            />
          </div>
        )}
      </div>
    </div>
    </>
  )
}

// Merge next message list into prev — only re-renders if something actually changed
function mergeMessages(prev: Message[], next: Message[]): Message[] {
  if (prev.length === next.length) {
    const identical = next.every((m, i) =>
      prev[i].id === m.id && prev[i].content === m.content && prev[i].result === m.result,
    )
    if (identical) return prev
  }
  return next
}

function JarvisIndicator({ isThinking }: { isThinking: boolean }) {
  const [staticFrame, setStaticFrame] = useState<string | null>(null)

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d')?.drawImage(img, 0, 0)
      setStaticFrame(canvas.toDataURL())
    }
    img.src = '/images/jarvis_loading.gif'
  }, [])

  return (
    <div className='flex items-start mb-3'>
      <img
        key={isThinking ? 'thinking' : 'idle'}
        src={isThinking ? '/images/jarvis_loading.gif' : (staticFrame || '/images/jarvis_loading.gif')}
        alt='Jarvis'
        className='w-10 h-10 mix-blend-multiply dark:mix-blend-screen'
      />
    </div>
  )
}

type MessageItem = { type: 'message'; msg: Message } | { type: 'separator'; key: string; label: string }

function groupMessagesByDay(messages: Message[]): MessageItem[] {
  const result: MessageItem[] = []
  let lastDay = ''

  for (const msg of messages) {
    const date = new Date((msg.created_at || 0) * 1000)
    const dayKey = date.toDateString()

    if (dayKey !== lastDay) {
      lastDay = dayKey
      result.push({ type: 'separator', key: `sep-${dayKey}`, label: formatDayLabel(date) })
    }
    result.push({ type: 'message', msg })
  }

  return result
}

function formatDayLabel(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

  const diffDays = Math.floor((today.getTime() - date.getTime()) / 86_400_000)
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'long' })
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })
}

function DateSeparator({ label }: { label: string }) {
  return (
    <div data-date-label={label} className='flex items-center gap-3 my-4'>
      <div className='flex-1 h-px bg-border' />
      <span className='text-[11px] text-text-muted/60 font-medium shrink-0'>{label}</span>
      <div className='flex-1 h-px bg-border' />
    </div>
  )
}

function ConvStatusIcons({ conversationId, hasCron, hasWebhook, notify }: { conversationId?: string; hasCron: boolean; hasWebhook: boolean; notify: string }) {
  const navigate = useNavigate()
  const any = hasCron || hasWebhook || notify === 'unsubscribe' || notify === 'auto'
  if (!any) return null
  return (
    <span className='flex items-center gap-3 shrink-0'>
      {hasCron && (
        <Clock
          size={14}
          className='text-text-muted hover:text-accent transition-colors cursor-pointer'
          onClick={() => conversationId && navigate(`/crons?conversation_id=${conversationId}`)}
        />
      )}
      {hasWebhook && (
        <Link2
          size={14}
          className='text-text-muted hover:text-accent transition-colors cursor-pointer'
          onClick={() => conversationId && navigate(`/webhooks?conversation_id=${conversationId}`)}
        />
      )}
      {notify === 'unsubscribe' && <BellOff size={14} className='text-text-muted' />}
      {notify === 'auto' && <BellRing size={14} className='text-text-muted' />}
    </span>
  )
}

function MessageSkeleton() {
  return (
    <div className='space-y-6 animate-fade-in'>
      {/* User message skeleton */}
      <div className='flex justify-end'>
        <div className='skeleton h-10 w-48 rounded-2xl' />
      </div>
      {/* Assistant message skeleton */}
      <div className='flex justify-start'>
        <div className='space-y-2 max-w-[70%]'>
          <div className='skeleton h-4 w-80' />
          <div className='skeleton h-4 w-64' />
          <div className='skeleton h-4 w-72' />
        </div>
      </div>
      {/* Another pair */}
      <div className='flex justify-end'>
        <div className='skeleton h-10 w-36 rounded-2xl' />
      </div>
      <div className='flex justify-start'>
        <div className='space-y-2 max-w-[70%]'>
          <div className='skeleton h-4 w-72' />
          <div className='skeleton h-4 w-56' />
        </div>
      </div>
    </div>
  )
}
