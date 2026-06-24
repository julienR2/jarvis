import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { Clock, Link2, BellOff, BellRing } from 'lucide-react'
import {
  api,
  type Message,
  type Attachment,
  type Conversation,
} from '../api'
import { useChatStore } from '../stores/chatStore'
import { useChatEvents } from '../hooks/useChatEvents'
import MessageBubble from './MessageBubble'
import ChatInput from './ChatInput'
import { DEFAULT_MODEL } from './ModelSelector'
import AppPreview from './AppPreview'
import { ContentTitle } from './ContentLayout'
import ConversationMenu from './ConversationMenu'

const EMPTY_MESSAGES: readonly Message[] = []

interface ShareIntent {
  title?: string
  text?: string
  url?: string
  files?: File[]
}

interface Props {
  initialMessage?: string | null
  onInitialMessageConsumed?: () => void
  initialFiles?: File[] | null
  onInitialFilesConsumed?: () => void
  shareIntent?: ShareIntent | null
  onShareIntentConsumed?: () => void
}

export default function ChatView({
  initialMessage,
  onInitialMessageConsumed,
  initialFiles,
  onInitialFilesConsumed,
  shareIntent,
  onShareIntentConsumed,
}: Props) {
  const { id: conversationId } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const conv = useChatStore((s) =>
    conversationId ? s.conversations[conversationId] : undefined,
  )
  const messages = useChatStore(
    (s) =>
      (conversationId ? s.messages[conversationId] : undefined) ??
      (EMPTY_MESSAGES as Message[]),
  )
  const isProcessing = useChatStore((s) =>
    conversationId ? !!s.processing[conversationId] : false,
  )
  const loaded = useChatStore((s) =>
    conversationId ? !!s.convsLoaded[conversationId] : false,
  )

  const title = conv?.title ?? ''
  const hasApp = !!conv?.app_path
  const notify: Conversation['notify'] = conv?.notify ?? 'subscribe'
  const model = conv?.model ?? DEFAULT_MODEL
  const thinking = !!conv?.thinking
  const hasCron = !!conv?.has_cron
  const hasWebhook = !!conv?.has_webhook
  const pinned = !!conv?.pinned
  const showSkeleton = !loaded && messages.length === 0

  const { appRefreshKey, bumpApp } = useChatEvents(conversationId)
  const [showPreview, setShowPreview] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null)
  const [showFloating, setShowFloating] = useState(false)

  useEffect(() => {
    setShowPreview(true)
  }, [conversationId])

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

  function sendMessage(text: string, attachments: Attachment[] = []) {
    if (!text.trim() && attachments.length === 0) return
    if (!conversationId) return

    api
      .sendMessage(conversationId, text, attachments.length > 0 ? attachments : undefined)
      .catch((err) => {
        console.error('Failed to send message:', err)
      })
  }

  async function sendAudio(audioBlob: Blob) {
    if (!conversationId) return
    await api.sendAudio(conversationId, audioBlob)
  }

  function handleNotifyChange(mode: Conversation['notify']) {
    if (!conversationId) return
    useChatStore.getState().patchConversation(conversationId, { notify: mode })
  }

  function handleModelChange(newModel: string) {
    if (!conversationId) return
    useChatStore.getState().patchConversation(conversationId, { model: newModel })
  }

  function handleThinkingChange(newThinking: boolean) {
    if (!conversationId) return
    useChatStore
      .getState()
      .patchConversation(conversationId, { thinking: newThinking ? 1 : 0 })
  }

  function handlePinChange(newPinned: boolean) {
    if (!conversationId) return
    useChatStore
      .getState()
      .patchConversation(conversationId, { pinned: newPinned ? 1 : 0 })
  }

  function startRename() {
    setRenameValue(title)
    setRenaming(true)
  }

  async function submitRename() {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== title && conversationId) {
      await useChatStore
        .getState()
        .patchConversation(conversationId, { title: trimmed })
    }
    setRenaming(false)
  }

  async function handleDelete() {
    if (!conversationId) return
    await useChatStore.getState().deleteConversation(conversationId)
    navigate('/', { replace: true })
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
            action={conversationId ? (
              <span className='flex items-center gap-2'>
                <ConvStatusIcons conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} notify={notify} />
                <ConversationMenu onDelete={handleDelete} onRename={startRename} notify={notify} onNotifyChange={handleNotifyChange} model={model} thinking={thinking} onModelChange={handleModelChange} onThinkingChange={handleThinkingChange} conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} pinned={pinned} onPinChange={handlePinChange} onRefreshApp={hasApp ? bumpApp : undefined} appUrl={hasApp ? `/api/apps/${conv!.app_path!.replace(/^apps\//, '')}/index.html?token=${localStorage.getItem('token') || ''}&v=${appRefreshKey}` : undefined} />
              </span>
            ) : undefined}
          >
            <span className='flex items-center gap-3'>
              <span className='truncate flex-1'>{title}</span>
              {hasApp && (
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
          className={`flex flex-col h-full ${hasApp ? 'md:w-3/5 md:border-r md:border-border' : 'w-full'} ${hasApp && showPreview ? 'hidden md:flex' : 'flex w-full'}`}
        >
          {/* Desktop title — inside chat pane so preview gets full height */}
          {title && (
            <div className='hidden md:block'>
              <ContentTitle
                action={conversationId ? (
                  <span className='flex items-center gap-2'>
                    <ConvStatusIcons conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} notify={notify} />
                    <ConversationMenu onDelete={handleDelete} onRename={startRename} notify={notify} onNotifyChange={handleNotifyChange} model={model} thinking={thinking} onModelChange={handleModelChange} onThinkingChange={handleThinkingChange} conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} pinned={pinned} onPinChange={handlePinChange} />
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

            <div ref={scrollContainerRef} className={`h-full overflow-y-auto overflow-x-clip flex flex-col-reverse pb-6 ${messages.length === 0 ? 'pt-4' : 'pt-0'}`} onScroll={handleScroll}>
              <div className='max-w-3xl mx-auto px-4 md:px-6 min-w-0 w-full'>
                {showSkeleton ? (
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
            autoFocus={!showSkeleton && messages.length === 0}
            initialText={initialMessage || undefined}
            initialFiles={initialFiles || undefined}
            onInitialFilesConsumed={onInitialFilesConsumed}
          />
        </div>

        {/* Preview pane */}
        {hasApp && (
          <div
            className={`${showPreview ? 'flex' : 'hidden md:flex'} flex-col h-full ${showPreview ? 'w-full' : ''} md:w-2/5`}
          >
            <AppPreview
              appSlug={conv!.app_path!.replace(/^apps\//, '')}
              refreshKey={appRefreshKey}
              onRefresh={bumpApp}
              shareIntent={shareIntent}
              onShareIntentConsumed={onShareIntentConsumed}
            />
          </div>
        )}
      </div>
    </div>
    </>
  )
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
