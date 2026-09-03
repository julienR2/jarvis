import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { Clock, Link2, BellOff, BellRing, Loader2, ArrowUp } from 'lucide-react'
import {
  api,
  type Message,
  type Attachment,
  type Conversation,
} from '../api'
import { useChatStore } from '../stores/chatStore'
import { useChatEvents } from '../hooks/useChatEvents'
import MessageBubble, { markdownComponents } from './MessageBubble'
import ChatInput from './ChatInput'
import { DEFAULT_MODEL, DEFAULT_EFFORT } from './ModelSelector'
import AppPreview from './AppPreview'
import { ContentTitle } from './ContentLayout'

/** Shared so the jump button can find the divider without threading a ref
 *  through the day-grouping list. */
const UNREAD_ANCHOR_ID = 'unread-anchor'

import ConversationMenu from './ConversationMenu'
import SectionPicker from './SectionPicker'

const EMPTY_MESSAGES: readonly Message[] = []

interface ShareIntent {
  title?: string
  text?: string
  url?: string
  files?: File[]
}

/**
 * How a shared link renders this view.
 *
 * The shared page is this component, not a copy of it — so a change to chat
 * shows up there too. All a share does is drop the things that act on the
 * owner's instance (the conversation menu, model and effort, rename, delete)
 * and, for a read-only link, the composer.
 */
export interface SharedMode {
  readOnly: boolean
}

interface Props {
  /** Overrides the route param — the shared route carries a token, not an id. */
  conversationId?: string
  shared?: SharedMode
  initialMessage?: string | null
  onInitialMessageConsumed?: () => void
  initialFiles?: File[] | null
  onInitialFilesConsumed?: () => void
  shareIntent?: ShareIntent | null
  onShareIntentConsumed?: () => void
}

export default function ChatView({
  conversationId: conversationIdProp,
  shared,
  initialMessage,
  onInitialMessageConsumed,
  initialFiles,
  onInitialFilesConsumed,
  shareIntent,
  onShareIntentConsumed,
}: Props) {
  const { id: routeId } = useParams<{ id: string }>()
  const conversationId = conversationIdProp ?? routeId
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
  // NB: the live streaming buffer is deliberately *not* subscribed here. It
  // changes many times a second, and ChatView renders the whole message list —
  // every delta would re-run ReactMarkdown for every bubble in the conversation.
  // LiveTurn subscribes for itself.
  const loaded = useChatStore((s) =>
    conversationId ? !!s.convsLoaded[conversationId] : false,
  )
  const hasMore = useChatStore((s) =>
    conversationId ? !!s.hasMore[conversationId] : false,
  )
  const unreadAnchor = useChatStore((s) =>
    conversationId ? s.unreadAnchor[conversationId] ?? null : null,
  )

  const title = conv?.title ?? ''
  const hasApp = !!conv?.app_path

  // Share link for the conversation's app: a token scoped to this app alone,
  // rotatable, and carrying none of the account rights the session JWT does.
  const [appShareToken, setAppShareToken] = useState('')
  useEffect(() => {
    if (!hasApp || !conversationId) return
    let cancelled = false
    api.getAppToken(conversationId)
      .then(({ token }) => { if (!cancelled) setAppShareToken(token) })
      .catch(() => { /* link stays hidden until the token resolves */ })
    return () => { cancelled = true }
  }, [hasApp, conversationId])
  const appShareUrl =
    hasApp && appShareToken
      ? `/api/apps/${conv!.app_path!.replace(/^apps\//, '')}/index.html?token=${appShareToken}`
      : undefined
  const notify: Conversation['notify'] = conv?.notify ?? 'subscribe'
  const model = conv?.model ?? DEFAULT_MODEL
  const effort = conv?.effort ?? DEFAULT_EFFORT
  const hasCron = !!conv?.has_cron
  const hasWebhook = !!conv?.has_webhook
  const sectionId = conv?.section_id ?? null
  const contextTokens = conv?.context_tokens ?? null
  const contextWindow = conv?.context_window ?? null
  const showSkeleton = !loaded && messages.length === 0
  const lastMessageId = messages[messages.length - 1]?.id

  const { appRefreshKey, bumpApp } = useChatEvents(conversationId)
  const [showPreview, setShowPreview] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [moving, setMoving] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null)
  const [showFloating, setShowFloating] = useState(false)
  // Whether the unread divider has scrolled out of view. Drives the jump
  // button: with nothing to jump *to* on screen, the divider alone is easy to
  // miss, and on a long backlog you land at the newest message with no idea
  // where reading should start.
  const [unreadOffscreen, setUnreadOffscreen] = useState(false)

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

  // Start each conversation at the bottom (col-reverse: scrollTop 0 = bottom).
  useEffect(() => {
    const container = scrollContainerRef.current
    if (container) container.scrollTop = 0
  }, [conversationId])

  // The unread divider lasts exactly one visit: it stays put while the
  // conversation is open — scrolling past it doesn't erase where you had got
  // to — and is dropped on the way out. Coming back re-computes it from
  // whatever arrived since.
  useEffect(() => {
    if (!conversationId) return
    return () => useChatStore.getState().clearUnreadAnchor(conversationId)
  }, [conversationId])

  // Follow the conversation as it grows — but only when already at the bottom.
  // Scrolled up means the user is reading history: neither new messages nor
  // prepended older pages should yank the viewport away. (The list lives in a
  // flex-col-reverse container, so a prepend keeps visible messages in place
  // and scrollTop is 0 at the bottom, going negative upward.)
  // A message of the user's own is the exception: they just sent it (typed, or
  // dictated a few seconds earlier), so it is always brought into view. Left to
  // the rule above it could land below the fold whenever the viewport had
  // drifted, which is how a voice message or an image attachment came across as
  // never having been sent at all.
  useEffect(() => {
    const container = scrollContainerRef.current
    const ownMessageLast = messages[messages.length - 1]?.role === 'user'
    if (!ownMessageLast && container && Math.abs(container.scrollTop) > 100) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isProcessing])

  // Watch the divider so the jump button only appears when it is off screen.
  // Re-created on message changes because the divider is remounted as the list
  // grows, and an observer bound to a detached node reports nothing.
  useEffect(() => {
    setUnreadOffscreen(false)
    if (!unreadAnchor) return
    const root = scrollContainerRef.current
    const el = document.getElementById(UNREAD_ANCHOR_ID)
    if (!root || !el) return
    const observer = new IntersectionObserver(
      ([entry]) => setUnreadOffscreen(!entry.isIntersecting),
      { root },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [unreadAnchor, messages.length])

  // How many replies arrived since you last looked — counted from the divider,
  // so it matches exactly what sits below it.
  const unreadCount = useMemo(() => {
    if (!unreadAnchor) return 0
    const i = messages.findIndex((m) => m.id === unreadAnchor)
    if (i < 0) return 0
    return messages.slice(i).filter((m) => m.role === 'assistant' && !m.type).length
  }, [messages, unreadAnchor])

  function jumpToFirstUnread() {
    document
      .getElementById(UNREAD_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // Load the previous page as the top of the list approaches the viewport.
  // Re-created on every length change so that a page which lands entirely
  // inside the prefetch margin immediately triggers the next one.
  useEffect(() => {
    const sentinel = topSentinelRef.current
    const root = scrollContainerRef.current
    if (!conversationId || !hasMore || !sentinel || !root) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          useChatStore.getState().loadOlderMessages(conversationId)
        }
      },
      { root, rootMargin: '600px 0px 0px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [conversationId, hasMore, messages.length])

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

  function handleEffortChange(newEffort: Conversation['effort']) {
    if (!conversationId) return
    useChatStore
      .getState()
      .patchConversation(conversationId, { effort: newEffort })
  }

  function handleMove(newSectionId: string | null) {
    if (!conversationId) return
    useChatStore
      .getState()
      .patchConversation(conversationId, { section_id: newSectionId })
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
    {moving && (
      <SectionPicker
        currentId={sectionId}
        onPick={handleMove}
        onClose={() => setMoving(false)}
      />
    )}
    <div className='flex flex-col h-full'>
      {/* Mobile title bar + toggle — above both panes */}
      {title && (
        <div className='md:hidden'>
          <ContentTitle
            action={conversationId && !shared ? (
              <span className='flex items-center gap-2'>
                <ConvStatusIcons conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} notify={notify} />
                <ContextGauge tokens={contextTokens} windowTokens={contextWindow} />
                <ConversationMenu onDelete={handleDelete} onRename={startRename} notify={notify} onNotifyChange={handleNotifyChange} model={model} effort={effort} onModelChange={handleModelChange} onEffortChange={handleEffortChange} conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} onMove={() => setMoving(true)} onRefreshApp={hasApp ? bumpApp : undefined} appUrl={hasApp ? appShareUrl : undefined} onRotateAppToken={hasApp && conversationId ? async () => { const { token } = await api.rotateAppToken(conversationId); setAppShareToken(token) } : undefined} />
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
                action={conversationId && !shared ? (
                  <span className='flex items-center gap-2'>
                    <ConvStatusIcons conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} notify={notify} />
                    <ContextGauge tokens={contextTokens} windowTokens={contextWindow} />
                    <ConversationMenu onDelete={handleDelete} onRename={startRename} notify={notify} onNotifyChange={handleNotifyChange} model={model} effort={effort} onModelChange={handleModelChange} onEffortChange={handleEffortChange} conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} onMove={() => setMoving(true)} />
                  </span>
                ) : undefined}
              >
                {title}
              </ContentTitle>
            </div>
          )}

          {/* Messages */}
          <div className='relative flex-1 min-h-0'>
            {/* Jump to where reading left off. Only while the divider is out
                of sight — on screen it speaks for itself. */}
            {unreadAnchor && unreadOffscreen && (
              <button
                onClick={jumpToFirstUnread}
                className='absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-md hover:bg-accent-hover transition-colors'
              >
                <ArrowUp size={13} />
                {unreadCount > 0
                  ? `${unreadCount} new message${unreadCount > 1 ? 's' : ''}`
                  : 'First unread'}
              </button>
            )}

            {/* Floating date pill — shifts down so the jump button keeps the top slot */}
            <div
              className={`absolute left-1/2 -translate-x-1/2 z-10 pointer-events-none transition-all duration-300 ${unreadAnchor && unreadOffscreen ? 'top-14' : 'top-3'} ${showFloating && floatingLabel ? 'opacity-100' : 'opacity-0'}`}
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
                    {hasMore && (
                      <div ref={topSentinelRef} className='flex justify-center py-4'>
                        <Loader2 size={16} className='animate-spin text-text-muted' />
                      </div>
                    )}
                    {groupMessagesByDay(messages, unreadAnchor).map((item) =>
                      item.type === 'separator' ? (
                        <DateSeparator key={item.key} label={item.label} />
                      ) : item.type === 'unread' ? (
                        <UnreadSeparator key={item.key} />
                      ) : (
                        <MessageBubble
                          key={item.msg.id}
                          msg={item.msg}
                          // The newest message while a turn runs is the one
                          // being written, and it keeps its current run of
                          // steps unfolded.
                          live={isProcessing && item.msg.id === lastMessageId}
                        />
                      ),
                    )}
                    <LiveTurn conversationId={conversationId} />
                    <JarvisIndicator isThinking={isProcessing} />
                  </>
                )}
                <div ref={bottomRef} />
              </div>
            </div>
          </div>

          {/* Input — absent on a read-only link, present on an editable one */}
          {!shared?.readOnly && (
          <ChatInput
            onSend={sendMessage}
            onSendAudio={sendAudio}
            onCancel={cancelMessage}
            isProcessing={isProcessing}
            conversationId={conversationId}
            autoFocus={!showSkeleton && messages.length === 0}
            initialText={initialMessage || undefined}
            initialFiles={initialFiles || undefined}
            onInitialFilesConsumed={onInitialFilesConsumed}
          />
          )}
        </div>

        {/* Preview pane */}
        {hasApp && (
          <div
            className={`${showPreview ? 'flex' : 'hidden md:flex'} flex-col h-full ${showPreview ? 'w-full' : ''} md:w-2/5`}
          >
            <AppPreview
              appSlug={conv!.app_path!.replace(/^apps\//, '')}
              appToken={appShareToken}
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

/**
 * Reveal `target` progressively, so text appears word-by-word regardless of how
 * chunkily it arrived.
 *
 * This has to be client-side. The CLI batches its own partial messages before we
 * ever see them (a 241-char answer measured as 8 deltas, some 100+ chars), so
 * network events alone render as a few big jumps no matter how fast we forward
 * them. Decoupling the reveal from arrival is what makes it read as typing.
 *
 * Catches up proportionally — a fixed chars-per-tick rate would fall further and
 * further behind on a long answer and still be typing after the turn ended.
 */
function useTypewriter(target: string): string {
  const [shown, setShown] = useState(0)

  // Read through a ref inside the tick so the interval doesn't have to be torn
  // down and rebuilt on every delta (or, worse, on every tick).
  const targetRef = useRef(target)
  targetRef.current = target

  // The buffer only ever shrinks when it is cleared for a new turn (or a partial
  // is retracted), so the reveal restarts with it — adjusted during render, not
  // in an effect, which would leave a frame showing the new turn's opening text
  // in one jump. Merely clamping was worse still: `shown` stayed at the previous
  // turn's length, so every turn after the first appeared instantly.
  if (shown > target.length) setShown(target.length)

  const revealed = Math.min(shown, target.length)
  const caughtUp = revealed >= target.length

  useEffect(() => {
    if (caughtUp) return
    const id = setInterval(() => {
      setShown((n) => {
        const len = targetRef.current.length
        const at = Math.min(n, len)
        if (at >= len) return at
        // ~25% of the backlog per tick, min 2 chars: converges fast on a burst,
        // still visibly incremental on a trickle.
        return at + Math.max(2, Math.ceil((len - at) * 0.25))
      })
    }, 33)
    return () => clearInterval(id)
  }, [caughtUp])

  return target.slice(0, revealed)
}

/**
 * The answer text of the turn in progress.
 *
 * Not persisted: when the block closes, the real message row arrives and the
 * store clears this. It renders through `markdownComponents` — the same renderer
 * MessageBubble uses — so that swap doesn't re-layout.
 */
function LiveTurn({ conversationId }: { conversationId?: string }) {
  const streaming = useChatStore((s) =>
    conversationId ? s.streaming[conversationId] ?? '' : '',
  )
  const shown = useTypewriter(streaming)
  if (!shown) return null

  return (
    <div className='flex items-start mb-5'>
      <div className='max-w-full min-w-0'>
        <div className='markdown text-base leading-relaxed'>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={markdownComponents}
          >
            {shown}
          </ReactMarkdown>
        </div>
      </div>
    </div>
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

type MessageItem =
  | { type: 'message'; msg: Message }
  | { type: 'separator'; key: string; label: string }
  | { type: 'unread'; key: string }

function groupMessagesByDay(messages: Message[], unreadAnchor: string | null): MessageItem[] {
  const result: MessageItem[] = []
  let lastDay = ''

  for (const msg of messages) {
    const date = new Date((msg.created_at || 0) * 1000)
    const dayKey = date.toDateString()

    if (dayKey !== lastDay) {
      lastDay = dayKey
      result.push({ type: 'separator', key: `sep-${dayKey}`, label: formatDayLabel(date) })
    }
    // Below the day separator, not above it: the divider marks where reading
    // resumes, and that is inside the day, not before it.
    if (msg.id === unreadAnchor) result.push({ type: 'unread', key: `unread-${msg.id}` })
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

// Where reading left off. Same shape as the date separator so the two stack
// without fighting, in the accent colour so it reads as a state and not as
// another date.
function UnreadSeparator() {
  return (
    // scroll-mt keeps the label clear of the floating pills when jumped to.
    <div id={UNREAD_ANCHOR_ID} className='flex items-center gap-3 my-5 scroll-mt-24'>
      <div className='flex-1 h-px bg-accent' />
      <span className='shrink-0 rounded-full bg-accent px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white shadow-sm'>
        New
      </span>
      <div className='flex-1 h-px bg-accent' />
    </div>
  )
}

// Donut showing how full the conversation's context is. Hidden below 50% —
// under that there is nothing to decide, and a permanent gauge would just be
// noise in the title bar.
const CONTEXT_GAUGE_THRESHOLD = 50

// `windowTokens`, not `window` — a prop by that name would shadow the global
// inside this component.
function ContextGauge({ tokens, windowTokens }: { tokens?: number | null; windowTokens?: number | null }) {
  if (!tokens || !windowTokens) return null
  const pct = Math.min(100, Math.round((tokens / windowTokens) * 100))
  if (pct < CONTEXT_GAUGE_THRESHOLD) return null

  const radius = 6
  const circumference = 2 * Math.PI * radius
  const color =
    pct >= 90 ? 'text-red-500' : pct >= 75 ? 'text-amber-500' : 'text-text-muted'

  return (
    <span
      className={`shrink-0 flex items-center ${color}`}
      title={`Context ${pct}% used — ${Math.round(tokens / 1000)}k / ${Math.round(windowTokens / 1000)}k tokens`}
    >
      <svg width='16' height='16' viewBox='0 0 16 16' className='-rotate-90'>
        <circle cx='8' cy='8' r={radius} fill='none' stroke='currentColor' strokeWidth='2' opacity='0.25' />
        <circle
          cx='8'
          cy='8'
          r={radius}
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
        />
      </svg>
    </span>
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
