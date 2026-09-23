import { useState, useEffect, useMemo, useRef } from 'react'
import { API_BASE, BASE_PATH } from '../base'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { Earth, Loader2, ArrowDown, EyeOff } from 'lucide-react'
import {
  api,
  pendingQuestionOf,
  questionsOf,
  type Message,
  type Attachment,
  type Conversation,
  type DeleteOptions,
  type ReplyTo,
  type Run,
} from '../api'
import { useChatStore } from '../stores/chatStore'
import { useChatEvents } from '../hooks/useChatEvents'
import MessageBubble, { markdownComponents } from './MessageBubble'
import ChatInput from './ChatInput'
import { DEFAULT_EFFORT, useModelCatalogue } from './ModelSelector'
import AppPreview from './AppPreview'
import ResizeHandle from './ResizeHandle'
import { useIsDesktop } from '../hooks/useIsDesktop'
import { ContentTitle } from './ContentLayout'
import RoutinesPill from './RoutinesPill'
import RunBlock from './RunBlock'
import SelectionReply from './SelectionReply'
import { dropQuietRuns, groupMessagesByDay, isFinishedReply } from '../lib/transcript'
import { answerFromComposer } from './AnswerCard'

/** Shared so the jump button can find the divider without threading a ref
 *  through the day-grouping list. */
const UNREAD_ANCHOR_ID = 'unread-anchor'

/** The app pane's share of the split, and what double-click returns to (w-2/5). */
const APP_DEFAULT_PCT = 40
const APP_MIN_PCT = 20
const APP_MAX_PCT = 75
const APP_PCT_KEY = 'app-pane-pct'

function readAppPct(): number {
  try {
    const raw = Number(localStorage.getItem(APP_PCT_KEY))
    return raw >= APP_MIN_PCT && raw <= APP_MAX_PCT ? raw : APP_DEFAULT_PCT
  } catch {
    return APP_DEFAULT_PCT
  }
}

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
  const recentRuns = useChatStore((s) =>
    conversationId ? s.recentRuns[conversationId] : undefined,
  )
  // Lets the transcript markers name their run without scanning the list once
  // per marker. Rebuilt only when the runs change, not on every message.
  const runsById = useMemo(
    () => new Map((recentRuns ?? []).map((r) => [r.id, r])),
    [recentRuns],
  )

  const title = conv?.title ?? ''
  const hasApp = !!conv?.app_path
  // The turn is parked on this until it is answered — the card at the bottom.
  const pending = useMemo(() => pendingQuestionOf(conv), [conv?.pending_question])
  // While a question (not an approval) is open, the composer answers it: what
  // is typed or dictated is the free-form option, files included.
  const composerAnswers = !!pending && questionsOf(pending).length > 0

  // Share link for the conversation's app: a token scoped to this app alone,
  // rotatable, and carrying none of the account rights the session JWT does.
  // Kept with the id it belongs to: across a chat switch the previous token
  // used to go out with the new chat's slug, the backend refused the pair and
  // the pane showed "Not found" until the right one arrived. A token for
  // another conversation now counts as no token at all.
  const [appShare, setAppShare] = useState<{ id: string; token: string } | null>(null)
  useEffect(() => {
    if (!hasApp || !conversationId) return
    let cancelled = false
    api.getAppToken(conversationId)
      .then(({ token }) => { if (!cancelled) setAppShare({ id: conversationId, token }) })
      .catch(() => { /* link stays hidden until the token resolves */ })
    return () => { cancelled = true }
  }, [hasApp, conversationId])
  const appShareToken = appShare && appShare.id === conversationId ? appShare.token : ''
  const appShareUrl =
    hasApp && appShareToken
      ? `${API_BASE}/apps/${conv!.app_path!.replace(/^apps\//, '')}/index.html?token=${appShareToken}`
      : undefined
  const notify: Conversation['notify'] = conv?.notify ?? 'subscribe'
  // `null` on the row means "the instance default", which depends on the
  // configured providers and which one is marked default — so it has to come
  // from the catalogue, not the compiled-in fallback. Using the constant here
  // showed Opus 5 on a gateway-default instance while the turn ran on the
  // gateway's model: the picker disagreed with what actually answered.
  const catalogueDefault = useModelCatalogue().default
  const model = conv?.model ?? catalogueDefault
  const effort = conv?.effort ?? DEFAULT_EFFORT
  const hasCron = !!conv?.has_cron
  const hasWebhook = !!conv?.has_webhook
  const shareMode = conv?.share_mode ?? null
  const sectionId = conv?.section_id ?? null
  const contextTokens = conv?.context_tokens ?? null
  const contextWindow = conv?.context_window ?? null
  const showSkeleton = !loaded && messages.length === 0
  const lastMessageId = messages[messages.length - 1]?.id

  const { appRefreshKey, bumpApp } = useChatEvents(conversationId)
  const [showPreview, setShowPreview] = useState(true)
  const isDesktop = useIsDesktop()
  // Stored as a percentage, not pixels: the split should hold its proportions
  // when the window is resized, which a pixel width does not.
  const [appPct, setAppPct] = useState(readAppPct)
  const splitRef = useRef<HTMLDivElement>(null)
  const appDragFrom = useRef(appPct)

  useEffect(() => {
    try {
      localStorage.setItem(APP_PCT_KEY, String(appPct))
    } catch {
      /* private window, or site data blocked — the split just won't persist */
    }
  }, [appPct])
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [moving, setMoving] = useState(false)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  // The passage the next message replies to, picked from a selection.
  const [quote, setQuote] = useState<ReplyTo | null>(null)
  useEffect(() => { setQuote(null) }, [conversationId])
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null)
  const [showFloating, setShowFloating] = useState(false)
  // Scrolled up, reading history. Shows the way back down (the round arrow
  // bottom-right) and freezes the count of answers that land meanwhile.
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  // Finished answers accounted for the last time the reader was at the bottom;
  // whatever arrived since is the badge on the arrow.
  const seenRef = useRef(0)
  // The conversation whose unread divider has been scrolled to on open.
  const positionedRef = useRef<string | null>(null)

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

  // The list flows top-down like a page, so text streaming in below the reader
  // moves nothing on screen: holding still costs no code. Following the stream
  // is the one thing done on purpose, and only while pinned — at the very
  // bottom, where a chat opens and where scrolling all the way down puts you
  // back. (It used to be flex-col-reverse, anchored to the bottom, with every
  // streamed chunk offset by hand when scrolled up; the offsets fought the
  // browser's own anchoring and the text still crept.)
  const pinnedRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  // The first item not yet scrolled past, and where it sat. What changes above
  // it — an older page landing, an image loading up there — would push the
  // reading down; putting it back is what browsers call scroll anchoring, done
  // here because Safari has none (`overflow-anchor` is off on the list so the
  // others don't do it twice).
  const anchorRef = useRef<{ el: Element; top: number } | null>(null)

  function recordAnchor() {
    const container = scrollContainerRef.current
    const content = contentRef.current
    if (!container || !content) return
    const top = container.getBoundingClientRect().top
    anchorRef.current = null
    for (const el of content.children) {
      // The older-page loader stays first whatever lands under it: anchored
      // to it, a page arriving would push the reading down by its height.
      if (el === topSentinelRef.current) continue
      const r = el.getBoundingClientRect()
      if (r.bottom > top) {
        anchorRef.current = { el, top: r.top }
        return
      }
    }
  }

  function pinToBottom() {
    const container = scrollContainerRef.current
    pinnedRef.current = true
    if (container) container.scrollTop = container.scrollHeight
  }

  // Start each conversation at the bottom. With unread answers the divider
  // effect below then moves up to them.
  useEffect(() => {
    pinToBottom()
    positionedRef.current = null
    seenRef.current = 0
    setAwayFromBottom(false)
  }, [conversationId])

  // The unread divider lasts exactly one visit: it stays put while the
  // conversation is open — scrolling past it doesn't erase where you had got
  // to — and is dropped on the way out. Coming back re-computes it from
  // whatever arrived since.
  useEffect(() => {
    if (!conversationId) return
    return () => useChatStore.getState().clearUnreadAnchor(conversationId)
  }, [conversationId])

  // The list grew or shrank, or the pane did (composer, keyboard): pinned, stay
  // at the bottom; reading, keep the anchor where it was. Runs after layout and
  // before paint, so neither shows as a jump.
  useEffect(() => {
    const container = scrollContainerRef.current
    const content = contentRef.current
    if (!container || !content) return
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) {
        container.scrollTop = container.scrollHeight
        return
      }
      const anchor = anchorRef.current
      if (anchor?.el.isConnected) {
        const shift = anchor.el.getBoundingClientRect().top - anchor.top
        if (shift !== 0) container.scrollTop += shift
      }
      recordAnchor()
      // Growth below fires no scroll event: the arrow is kept honest from here.
      setAwayFromBottom(container.scrollHeight - container.clientHeight - container.scrollTop > 150)
    })
    observer.observe(content)
    observer.observe(container)
    return () => observer.disconnect()
  }, [conversationId])

  // A message of the user's own is always brought into view: they just sent it
  // (typed, or dictated a few seconds earlier). Left to the pin it could land
  // below the fold whenever they had scrolled up, which is how a voice message
  // or an image attachment came across as never having been sent at all.
  const lastOwnRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (last?.role !== 'user' || last.id === lastOwnRef.current) return
    lastOwnRef.current = last.id
    pinToBottom()
  }, [messages])

  // Finished answers, the unit the unread count and the arrow badge share
  // (the server counts the same rows for the sidebar badge).
  const finishedCount = useMemo(
    () => messages.filter((m) => isFinishedReply(m, runsById)).length,
    [messages, runsById],
  )
  // How many replies arrived since you last looked — counted from the divider,
  // so it matches exactly what sits below it.
  const unreadCount = useMemo(() => {
    if (!unreadAnchor) return 0
    const i = messages.findIndex((m) => m.id === unreadAnchor)
    if (i < 0) return 0
    return messages
      .slice(i)
      .filter((m) => isFinishedReply(m, runsById)).length
  }, [messages, unreadAnchor, runsById])

  // At the bottom everything is seen; the badge starts counting from here.
  useEffect(() => {
    if (!awayFromBottom) seenRef.current = finishedCount
  }, [awayFromBottom, finishedCount])

  // Unread answers: open the chat at the divider, first unread at the top of
  // the viewport, the way a messenger does — no pill to go and find it. Once
  // per visit; the reader takes it from there. Seeing the divider does NOT
  // dismiss it: it marks where reading left off. Dismissing is the click, or
  // leaving the conversation. The answers under it are what the arrow's badge
  // starts at.
  useEffect(() => {
    if (!conversationId || !unreadAnchor || positionedRef.current === conversationId) return
    const el = document.getElementById(UNREAD_ANCHOR_ID)
    if (!el) return
    positionedRef.current = conversationId
    el.scrollIntoView({ block: 'start' })
    pinnedRef.current = false
    recordAnchor()
    seenRef.current = finishedCount - unreadCount
    setAwayFromBottom(true)
  }, [conversationId, unreadAnchor, messages.length])

  const newBelow = awayFromBottom ? Math.max(0, finishedCount - seenRef.current) : 0

  // A jump, not a glide: a smooth scroll aims at where the bottom was when it
  // started and lands short of it if the answer grew meanwhile.
  function scrollToBottom() {
    pinToBottom()
  }

  function dismissUnread() {
    if (!conversationId) return
    useChatStore.getState().dismissUnreadAnchor(conversationId)
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
    if (!conversationId) return

    // An empty send is allowed here: it confirms the options picked in the strip.
    if (composerAnswers && pending) {
      void answerFromComposer(conversationId, pending, text.trim(), attachments)
      return
    }
    if (!text.trim() && attachments.length === 0) return

    api
      .sendMessage(conversationId, text, attachments.length > 0 ? attachments : undefined, undefined, undefined, quote)
      .catch((err) => {
        console.error('Failed to send message:', err)
      })
    setQuote(null)
  }

  async function sendAudio(audioBlob: Blob) {
    if (!conversationId) return
    if (composerAnswers && pending) {
      // Dictated answer: transcribe here, then answer with the words.
      const { transcript } = await api.transcribeAudio(audioBlob)
      if (transcript.trim()) await answerFromComposer(conversationId, pending, transcript.trim(), [])
      return
    }
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

  async function handleDelete(opts: DeleteOptions) {
    if (!conversationId) return
    await useChatStore.getState().deleteConversation(conversationId, opts)
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

    // Pinned at the very bottom; unpinned only by going up. Measured from
    // here alone, the pin's own jump would undo itself: by the time its scroll
    // event fires the typewriter has often added a line, and the list reads as
    // "not quite at the bottom". The arrow appears once the latest messages are
    // genuinely out of view, not on the first pixel.
    const fromBottom = container.scrollHeight - container.clientHeight - container.scrollTop
    if (fromBottom <= 8) pinnedRef.current = true
    else if (container.scrollTop < lastScrollTopRef.current) pinnedRef.current = false
    lastScrollTopRef.current = container.scrollTop
    if (!pinnedRef.current) recordAnchor()
    setAwayFromBottom(fromBottom > 150)

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
                <RoutinesPill conversationId={conversationId} hasRoutines={hasCron || hasWebhook} />
                <ShareIcon shareMode={shareMode} />
                <ContextGauge tokens={contextTokens} windowTokens={contextWindow} />
                <ConversationMenu onDelete={handleDelete} onRename={startRename} notify={notify} onNotifyChange={handleNotifyChange} model={model} effort={effort} onModelChange={handleModelChange} onEffortChange={handleEffortChange} conversationId={conversationId} hasCron={hasCron} hasWebhook={hasWebhook} onMove={() => setMoving(true)} onRefreshApp={hasApp ? bumpApp : undefined} appUrl={hasApp ? appShareUrl : undefined} onRotateAppToken={hasApp && conversationId ? async () => { const { token } = await api.rotateAppToken(conversationId); setAppShare({ id: conversationId, token }) } : undefined} />
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
      <div ref={splitRef} className='flex flex-1 min-h-0'>
        {/* Chat pane — takes whatever the app pane leaves on desktop */}
        <div
          className={`flex flex-col h-full min-w-0 ${hasApp ? 'md:flex-1 md:border-r md:border-border' : 'w-full'} ${hasApp && showPreview ? 'hidden md:flex' : 'flex w-full'}`}
        >
          {/* Desktop title — inside chat pane so preview gets full height */}
          {title && (
            <div className='hidden md:block'>
              <ContentTitle
                action={conversationId && !shared ? (
                  <span className='flex items-center gap-2'>
                    <RoutinesPill conversationId={conversationId} hasRoutines={hasCron || hasWebhook} />
                    <ShareIcon shareMode={shareMode} />
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
          <div ref={paneRef} className='relative flex-1 min-h-0'>
            {!shared?.readOnly && <SelectionReply paneRef={paneRef} onQuote={setQuote} />}
            {/* Back to the latest messages, with what landed while reading up
                there. Bottom-right like every messenger; quiet until needed. */}
            {awayFromBottom && (
              <button
                onClick={scrollToBottom}
                title='Back to the latest messages'
                data-testid='jump-to-bottom'
                className='absolute bottom-4 right-4 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-bg-alt text-text-muted shadow-md transition-colors hover:text-text-primary'
              >
                <ArrowDown size={16} />
                {newBelow > 0 && (
                  <span
                    data-testid='jump-to-bottom-count'
                    className='absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white'
                  >
                    {newBelow}
                  </span>
                )}
              </button>
            )}

            {/* Floating date pill */}
            <div
              className={`absolute left-1/2 -translate-x-1/2 z-10 pointer-events-none transition-all duration-300 top-3 ${showFloating && floatingLabel ? 'opacity-100' : 'opacity-0'}`}
            >
              <span className='px-3 py-1 rounded-full bg-bg-alt text-[11px] text-text-muted font-medium border border-border shadow-sm'>
                {floatingLabel}
              </span>
            </div>

            <div ref={scrollContainerRef} data-testid='chat-scroll' className={`h-full overflow-y-auto overflow-x-clip [overflow-anchor:none] flex flex-col pb-6 ${messages.length === 0 ? 'pt-4' : 'pt-0'}`} onScroll={handleScroll}>
              <div ref={contentRef} className='mt-auto max-w-3xl mx-auto px-4 md:px-6 min-w-0 w-full'>
                {showSkeleton ? (
                  <MessageSkeleton />
                ) : (
                  <>
                    {hasMore && (
                      <div ref={topSentinelRef} className='flex justify-center py-4'>
                        <Loader2 size={16} className='animate-spin text-text-muted' />
                      </div>
                    )}
                    {dropQuietRuns(groupMessagesByDay(messages, unreadAnchor), runsById).map((item) =>
                      item.type === 'separator' ? (
                        <DateSeparator key={item.key} label={item.label} />
                      ) : item.type === 'unread' ? (
                        <UnreadSeparator key={item.key} onDismiss={dismissUnread} />
                      ) : item.type === 'runBlock' ? (
                        <RunBlock
                          key={item.key}
                          run={runsById.get(item.runId)}
                          msgs={item.msgs}
                          live={isProcessing && item.msgs.some((m) => m.id === lastMessageId)}
                          lastMessageId={lastMessageId}
                        />
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
                    {/* Parked is not thinking: the loader rests while he waits on you.
                        The question itself sits on the composer, below. */}
                    <JarvisIndicator isThinking={isProcessing && !pending} />
                  </>
                )}
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
            question={!shared?.readOnly && pending ? pending : undefined}
            initialText={initialMessage || undefined}
            initialFiles={initialFiles || undefined}
            onInitialFilesConsumed={onInitialFilesConsumed}
            quote={quote}
            onClearQuote={() => setQuote(null)}
          />
          )}
        </div>

        {/* Preview pane */}
        {hasApp && isDesktop && (
          <ResizeHandle
            label='Resize app panel'
            onStart={() => {
              appDragFrom.current = appPct
            }}
            onMove={(dx) => {
              const total = splitRef.current?.clientWidth ?? 0
              if (!total) return
              // Dragging right gives the chat more room, so the app's share falls.
              const next = appDragFrom.current - (dx / total) * 100
              setAppPct(Math.min(APP_MAX_PCT, Math.max(APP_MIN_PCT, next)))
            }}
            onReset={() => setAppPct(APP_DEFAULT_PCT)}
          />
        )}

        {hasApp && (
          <div
            className={`${showPreview ? 'flex' : 'hidden md:flex'} flex-col h-full min-w-0 ${showPreview ? 'w-full' : ''} ${isDesktop ? 'shrink-0' : ''}`}
            // Desktop only: on mobile this pane replaces the chat full-width,
            // so a share of a split it isn't part of would just break it.
            style={isDesktop ? { width: `${appPct}%` } : undefined}
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
    img.src = `${BASE_PATH}/images/jarvis_loading.gif`
  }, [])

  return (
    <div className='flex items-start mb-3'>
      <img
        key={isThinking ? 'thinking' : 'idle'}
        src={isThinking ? `${BASE_PATH}/images/jarvis_loading.gif` : (staticFrame || `${BASE_PATH}/images/jarvis_loading.gif`)}
        alt='Jarvis'
        className='w-10 h-10 mix-blend-multiply dark:mix-blend-screen'
      />
    </div>
  )
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

// Where reading left off. Same shape as the date separator — a label between
// two rules — so the two stack without fighting, but in accent rather than
// grey so it reads as a state and not as another date.
//
// Dimmed accent, not solid: this marker now persists for the whole visit, and
// at full strength it read as an error the entire time it was on screen. The
// subtle fill carries the same colour at a weight you can sit next to.
//
// Quiet, grey, a bookmark rather than an alert: the chat opens with it at the
// top of the viewport, so it needs no colour to be found. Clicking it is the
// way to put it away without leaving the conversation, so the whole row is the
// button and the rules darken with it on hover.
function UnreadSeparator({ onDismiss }: { onDismiss: () => void }) {
  return (
    // scroll-mt keeps the label clear of the header and the date pill.
    <button
      id={UNREAD_ANCHOR_ID}
      type='button'
      onClick={onDismiss}
      title='Click to dismiss'
      className='group flex w-full items-center gap-3 my-5 scroll-mt-16'
    >
      <div className='flex-1 h-px bg-border transition-colors group-hover:bg-text-muted/40' />
      <span className='shrink-0 rounded-full bg-surface2 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-text-muted transition-colors group-hover:text-text-primary'>
        Unread messages
      </span>
      <div className='flex-1 h-px bg-border transition-colors group-hover:bg-text-muted/40' />
    </button>
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

function ShareIcon({ shareMode }: { shareMode: Conversation['share_mode'] }) {
  if (!shareMode) return null
  return (
    <span className='flex items-center shrink-0' title={shareMode === 'write' ? 'Shared — can reply' : 'Shared — read-only'}>
      <Earth size={14} className='text-text-muted' />
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
