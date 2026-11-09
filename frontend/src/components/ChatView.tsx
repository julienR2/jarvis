import { Fragment, useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { API_BASE, BASE_PATH } from '../base'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import { Earth, Loader2, ArrowDown, EyeOff, FileText, Hash } from 'lucide-react'
import {
  api,
  pendingQuestionOf,
  type Message,
  type Attachment,
  type Conversation,
  type DeleteOptions,
  type ReplyTo,
  type Run,
} from '../api'
import { useChatStore } from '../stores/chatStore'
import { useChatEvents } from '../hooks/useChatEvents'
import MessageBubble, { Markdown, liveStatus, markdownComponents } from './MessageBubble'
import ChatInput, { type VoiceExtras } from './ChatInput'
import { DEFAULT_EFFORT, modelName, useModelCatalogue } from './ModelSelector'
import AppPreview from './AppPreview'
import SidePanel, { type PanelKey, type ThreadTab } from './SidePanel'
import ThreadsPill from './ThreadsPill'
import { useChatTabs, useTabsStore } from '../stores/tabsStore'
import { PanelOpenerContext } from '../lib/panelOpener'
import ResizeHandle from './ResizeHandle'
import { useIsDesktop } from '../hooks/useIsDesktop'
import { ContentTitle } from './ContentLayout'
import RunsPill from './RunsPill'
import RunBlock from './RunBlock'
import { RunReportCard, RunReportStack } from './RunReport'
import { confirmThreadMove, THREAD_GROUP } from '../lib/threads'
import { RoutineCard, RoutineChip } from './RoutineCard'
import ThreadPanel, { type ThreadPanelState } from './ThreadPanel'
import { useShallow } from 'zustand/react/shallow'
import { routineOf, ROUTINE_CHANGED_EVENT, type Routine } from '../lib/routines'
import { isActiveThread, isDraftThread, isSubChat, readThreadTabs, saveThreadTabs } from '../lib/threads'
import SelectionReply from './SelectionReply'
import { dropQuietRuns, groupMessagesByDay, isFinishedReply } from '../lib/transcript'
import { answerFromComposer } from './AnswerCard'
import { useOutbox, type Outgoing } from '../lib/outbox'
import { settleUploads, spoken } from '../lib/drafts'
import { readPaneView, savePaneView, type PaneView } from '../lib/paneView'

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
  /**
   * Drawn inside another chat's thread panel: no title bar (the panel has its
   * own), no side pane, no threads of its own, and the address bar isn't its.
   */
  embedded?: boolean
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
  embedded,
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

  // A thread reads like a channel: #name.
  const title = conv ? `${conv.kind === 'thread' ? '# ' : ''}${conv.title}` : ''
  const hasApp = !!conv?.app_path && !embedded
  // The turn is parked on this until it is answered — the card at the bottom.
  const pending = useMemo(() => pendingQuestionOf(conv), [conv?.pending_question])
  // While anything is open the composer answers it, never queues behind it: for
  // a question what is typed or dictated is the free-form option, files
  // included; for an approval it is a reply instead of a yes.
  const composerAnswers = !!pending

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
  const notify: Conversation['notify'] = conv?.notify ?? 'auto'
  // `null` on the row means "the instance default", which depends on the
  // configured providers and which one is marked default — so it has to come
  // from the catalogue, not the compiled-in fallback. Using the constant here
  // showed Opus 5 on a gateway-default instance while the turn ran on the
  // gateway's model: the picker disagreed with what actually answered.
  const catalogueDefault = useModelCatalogue().default
  // The picker belongs to the input: a pick applies to the next message only,
  // and is saved by sending it. Until then it is local, keyed to this chat so
  // switching conversations never carries it along.
  const [picked, setPicked] = useState<{ id: string; model: string; effort: Conversation['effort'] } | null>(null)
  const pick = picked && picked.id === conversationId ? picked : null
  const model = pick?.model ?? conv?.model ?? catalogueDefault
  const effort = pick?.effort ?? conv?.effort ?? DEFAULT_EFFORT
  // An answer names its model only when it differs from the answer before, so
  // a chat on one model reads as it always did and a switch is visible where
  // it happened. Rows from before models were recorded carry none and are
  // skipped rather than read as a change.
  const modelLabels = useMemo(() => {
    const labels = new Map<string, string>()
    let previous: string | null = null
    for (const m of messages) {
      if (m.role !== 'assistant' || m.type || !m.model) continue
      if (previous !== null && m.model !== previous) labels.set(m.id, modelName(m.model))
      previous = m.model
    }
    return labels
  }, [messages])
  const isThread = conv?.kind === 'thread'
  // A routine's thread attached to a chat does not notify on its own: the chat decides.
  const notifiesThroughParent = isThread && !!conv?.parent_id && !conv?.parent_message_id
  const shareMode = conv?.share_mode ?? null
  const sectionId = conv?.section_id ?? null
  const contextTokens = conv?.context_tokens ?? null
  const contextWindow = conv?.context_window ?? null
  // The first message of a chat just started from Today, still on its way.
  const outgoing = useOutbox((s) => (conversationId ? s[conversationId] : undefined))
  const showSkeleton = !loaded && messages.length === 0 && !outgoing
  const lastMessageId = messages[messages.length - 1]?.id

  // Tabs (documents, links) are the owner's: not on a share link, and not in
  // a thread shown inside another chat, which has no side pane of its own.
  const withTabs = !shared && !embedded
  const { appRefreshKey, bumpApp } = useChatEvents(conversationId, { tabs: withTabs })
  const tabs = useChatTabs(withTabs ? conversationId : undefined)
  const [searchParams, setSearchParams] = useSearchParams()
  // Threads of this chat: the sub-chats opened from its passages (or blank,
  // from the list), and the threads of the routines reporting into it.
  const subChats = useChatStore(useShallow((s) =>
    embedded ? [] : s.order.map((id) => s.conversations[id]).filter((c): c is Conversation => !!c && c.parent_id === conversationId && isSubChat(c)),
  ))
  const routineThreads = useChatStore(useShallow((s) =>
    embedded ? [] : s.order.map((id) => s.conversations[id]).filter((c): c is Conversation => !!c && c.parent_id === conversationId && c.kind === 'thread' && !c.parent_message_id),
  ))

  // Threads open beside the chat, as tabs of the side pane — kept per device
  // like the pane view. The one shown is in the address (`?thread=<id>`: it
  // survives a reload, and Back closes it); a new one, not until its first
  // message creates it.
  const [newThread, setNewThread] = useState<{ convId: string; quote: ReplyTo | null } | null>(null)
  const openThreadId = embedded ? null : searchParams.get('thread')
  const pendingNew = !!newThread && newThread.convId === conversationId
  const [savedThreadTabs, setSavedThreadTabs] = useState(() => ({ id: conversationId, ids: conversationId && !embedded ? readThreadTabs(conversationId) : [] }))
  if (savedThreadTabs.id !== conversationId) setSavedThreadTabs({ id: conversationId, ids: conversationId && !embedded ? readThreadTabs(conversationId) : [] })
  const openTabIds = savedThreadTabs.id === conversationId ? savedThreadTabs.ids : []
  const setOpenTabIds = (ids: string[]) => {
    setSavedThreadTabs({ id: conversationId, ids })
    if (conversationId) saveThreadTabs(conversationId, ids)
  }
  const knownThreads = new Map([...subChats, ...routineThreads].map((t) => [t.id, t]))
  const threadTabs: ThreadTab[] = [
    ...[...new Set([...openTabIds, ...(openThreadId ? [openThreadId] : [])])]
      .filter((id) => knownThreads.has(id) || id === openThreadId)
      .map((id) => {
        const t = knownThreads.get(id)
        return { key: `thread:${id}`, title: t?.title ?? 'Thread', unread: t?.unread_count ?? 0, routine: !!t && !t.parent_message_id }
      }),
    ...(pendingNew ? [{ key: 'thread:new', title: 'New thread', unread: 0 }] : []),
  ]
  // The thread chosen to be shown: it brings the side pane into view.
  const threadKey: PanelKey | null = pendingNew ? 'thread:new' : openThreadId ? `thread:${openThreadId}` : null
  const threadPanel: ThreadPanelState | null =
    pendingNew ? { kind: 'new', quote: newThread!.quote } : openThreadId ? { kind: 'open', id: openThreadId } : null

  // The side pane: the chat's app, the tabs opened beside it, its open
  // threads. A topic's documents alone don't open it — they wait behind the
  // toggle.
  const hasPanel = hasApp || tabs.length > 0 || threadTabs.length > 0
  const ownsPanel = hasApp || tabs.some((t) => !t.topic) || threadTabs.length > 0
  const isDesktop = useIsDesktop()
  // What this chat opens on: what it was last left showing on this device
  // (unset, the default) — unless something was just shared into its
  // composer, which then needs to be seen. That is for this visit only, so it
  // isn't saved as the choice.
  const openingView = (): PaneView | undefined => {
    const saved = conversationId ? readPaneView(conversationId) : undefined
    const shared = !!(initialMessage || initialFiles?.length)
    return shared && saved !== 'chat' ? (isDesktop ? 'both' : 'chat') : saved
  }
  const [pane, setPane] = useState(() => ({ id: conversationId, view: openingView() }))
  // Switched in the same render as the chat, not an effect later: a render
  // with the previous chat's panes would mount this one's composer hidden.
  if (pane.id !== conversationId) setPane({ id: conversationId, view: openingView() })
  const paneView = pane.id === conversationId ? pane.view : openingView()
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

  // `?run=` — opened from a report or the routines page: bring that run into
  // view, paging back through older messages until it is loaded.
  const focusRun = embedded ? null : searchParams.get('run')

  function openThread(id: string | null) {
    // Leaving a thread read: what landed while it was open was seen there.
    if (openThreadId && openThreadId !== id) {
      useChatStore.getState().markRead(openThreadId)
      api.markConversationRead(openThreadId).catch(() => {})
    }
    setNewThread(null)
    if (id && !openTabIds.includes(id)) setOpenTabIds([...openTabIds, id])
    setSearchParams((p) => {
      if (id) p.set('thread', id)
      else p.delete('thread')
      return p
    }, { replace: !id })
  }
  function closeThreadTab(key: string) {
    if (key === 'thread:new') return setNewThread(null)
    const id = key.slice('thread:'.length)
    setOpenTabIds(openTabIds.filter((t) => t !== id))
    if (id === openThreadId) openThread(null)
  }
  // Done: out of the chat's active list (and its tab). Any new message in it
  // brings it back.
  function archiveThread(id: string, archived: boolean) {
    useChatStore.getState().patchConversation(id, { archived_at: archived ? Math.floor(Date.now() / 1000) : null })
    if (archived) closeThreadTab(`thread:${id}`)
  }
  const sidePane: 'app' | null = hasPanel ? 'app' : null
  // Mobile has room for one pane: "both" (the desktop default) shows the app.
  // A chat with only documents opens on the chat: they are beside it, not it.
  // A thread just chosen shows beside the chat (on a phone, instead of it).
  const baseView: PaneView = paneView ?? (isDesktop ? (ownsPanel ? 'both' : 'chat') : hasApp ? 'app' : 'chat')
  const view: PaneView = threadKey ? (isDesktop ? (baseView === 'chat' ? 'both' : baseView) : 'app') : baseView
  const appShown = sidePane === 'app' && view !== 'chat'
  const chatShown = sidePane !== 'app' || (isDesktop ? view !== 'app' : view === 'chat')

  // Desktop: each button adds or removes its pane, but one always stays.
  // Mobile: they pick the one pane shown.
  function togglePane(pane: 'chat' | 'app') {
    const shown = pane === 'chat' ? chatShown : appShown
    const other = pane === 'chat' ? appShown : chatShown
    const next: PaneView = !isDesktop ? pane : !shown ? 'both' : other ? (pane === 'chat' ? 'app' : 'chat') : pane
    // Putting the pane away puts its thread away too, or it would hold it open.
    if (threadKey && next === 'chat') openThread(null)
    setPane({ id: conversationId, view: next })
    if (conversationId) savePaneView(conversationId, next)
  }
  // Which tab the side pane shows: the app unless something else was picked
  // (or opened) in this chat — and back to it when that tab closes.
  const [activeTab, setActiveTab] = useState<{ id: string | undefined; key: PanelKey } | null>(null)
  const pickedKey = activeTab && activeTab.id === conversationId ? activeTab.key : null
  const panelKey: PanelKey = threadKey ?? (
    pickedKey && (pickedKey === 'app' ? hasApp : tabs.some((t) => t.id === pickedKey)) ? pickedKey
    : hasApp ? 'app'
    : [...tabs].reverse().find((t) => !t.topic)?.id ?? tabs[tabs.length - 1]?.id ?? threadTabs[threadTabs.length - 1]?.key ?? 'app')
  const activate = (key: PanelKey) => {
    if (key.startsWith('thread:')) {
      if (key !== 'thread:new') openThread(key.slice('thread:'.length))
      return
    }
    if (threadKey) openThread(null)
    setActiveTab({ id: conversationId, key })
  }

  // Show the side pane for this visit, without making it the chat's saved choice.
  const revealPanel = () => {
    if (!appShown) setPane({ id: conversationId, view: isDesktop ? 'both' : 'app' })
  }

  // Jarvis opened a tab: bring it forward. On desktop the pane opens beside
  // the chat; on the phone the view is left alone — the link in the answer
  // opens it. Only a fresh ask counts: one left over from before this chat
  // was opened is history.
  const focusAsk = useTabsStore((s) => (conversationId ? s.focus[conversationId] : undefined))
  useEffect(() => {
    if (!focusAsk || Date.now() - focusAsk.nonce > 15_000) return
    activate(focusAsk.tabId)
    if (isDesktop) revealPanel()
  }, [focusAsk?.nonce])

  // A file link clicked in the chat opens as the temporary tab, shown at once.
  const openFile = useCallback((path: string) => {
    if (!conversationId) return
    api.openTab(conversationId, { kind: 'doc', target: path })
      .then(({ tab, tabs }) => {
        useTabsStore.getState().setTabs(conversationId, tabs)
        setActiveTab({ id: conversationId, key: tab.id })
        setPane((p) => {
          const shown = p.id === conversationId && (isDesktop ? p.view === 'both' || p.view === 'app' : p.view === 'app')
          return shown ? p : { id: conversationId, view: isDesktop ? 'both' : 'app' }
        })
      })
      .catch((e: Error) => window.__jarvisToast?.info(`Couldn't open it beside the chat: ${e.message}`))
  }, [conversationId, isDesktop])

  // `window.jarvis` in the chat's app (app-jarvis-bridge.ts): the app asks,
  // this answers with the owner's session, which never enters the frame.
  const handleAppCall = useCallback(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    if (!conversationId) throw new Error('No chat')
    switch (method) {
      case 'send': {
        const text = String(args.text ?? '').trim()
        if (!text) throw new Error('Empty message')
        await api.sendMessage(conversationId, text, undefined, model, effort)
        useChatStore.getState().rememberModel(conversationId, model, effort)
        return true
      }
      case 'ask': {
        const { answer } = await api.askFromApp(conversationId, String(args.prompt ?? ''))
        return answer
      }
      case 'run': {
        const { answer } = await api.runFromApp(conversationId, String(args.name ?? ''), args.payload ?? {}, args.sync === true)
        return answer ?? true
      }
      case 'openDoc':
        openFile(String(args.path ?? ''))
        return true
      case 'context':
        return { conversationId, title: conv?.title ?? '', topicId: conv?.section_id ?? null }
      default:
        throw new Error(`Unknown jarvis method: ${method}`)
    }
  }, [conversationId, model, effort, openFile, conv?.title, conv?.section_id])

  // The threads started from each message, for the marks under them.
  const threadsByMessage = useMemo(() => {
    const map = new Map<string, Conversation[]>()
    for (const t of subChats) {
      const list = map.get(t.parent_message_id!) ?? []
      list.push(t)
      map.set(t.parent_message_id!, list)
    }
    return map
  }, [subChats])
  const threadMarks = (ids: string[]) => {
    const threads = ids.flatMap((id) => threadsByMessage.get(id) ?? [])
    if (embedded || threads.length === 0) return null
    return <ThreadMarks threads={threads} openId={openThreadId} onOpen={openThread} />
  }
  const focusedRef = useRef<string | null>(null)
  // The run you landed on is lit for a moment, then keeps only its margin mark.
  const [runLit, setRunLit] = useState(false)
  useEffect(() => {
    if (!focusRun || !conversationId || !loaded || focusedRef.current === `${conversationId}:${focusRun}`) return
    const el = contentRef.current?.querySelector(`[data-run-id="${CSS.escape(focusRun)}"]`)
    if (el) {
      focusedRef.current = `${conversationId}:${focusRun}`
      pinnedRef.current = false
      requestAnimationFrame(() => {
        el.scrollIntoView({ block: 'start' })
        recordAnchor()
        setAwayFromBottom(true)
        setRunLit(true)
        setTimeout(() => setRunLit(false), 1800)
      })
    } else if (hasMore) {
      useChatStore.getState().loadOlderMessages(conversationId)
    }
  }, [focusRun, conversationId, loaded, messages, hasMore])

  // A routine's thread: the routine's card is its first "message" (the form,
  // in a new one), with a chip in the title bar for when the top is far up.
  // Jarvis can change it too, which shows up through ROUTINE_CHANGED_EVENT.
  const threadOf = conv?.thread_of ?? null
  const [routine, setRoutine] = useState<Routine | null>(null)
  const reloadRoutine = useCallback(() => {
    if (!threadOf) return setRoutine(null)
    routineOf(threadOf).then(setRoutine).catch(() => setRoutine(null))
  }, [threadOf])
  useEffect(() => {
    setRoutine(null)
    reloadRoutine()
  }, [reloadRoutine, conversationId])
  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === conversationId) reloadRoutine()
    }
    window.addEventListener(ROUTINE_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(ROUTINE_CHANGED_EVENT, onChanged)
  }, [conversationId, reloadRoutine])
  const routineOpen = searchParams.get('routine') === 'open'

  // Opening a thread lists it in the sidebar's Threads group, where it stays
  // until dismissed — navigating away does not put it back.
  // Once per opening: putting it away while it is still on screen (the ✕,
  // just before the navigation away lands) must not list it straight back.
  const surfacedFor = useRef<string | null>(null)
  useEffect(() => {
    // In a chat's thread panel it is already where it belongs.
    if (!conv || shared || embedded || surfacedFor.current === conv.id) return
    surfacedFor.current = conv.id
    if (conv.kind === 'thread' && !conv.surfaced_at) useChatStore.getState().setThreadSurfaced(conv.id, true)
  }, [conv, shared, embedded])

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
    // A run asked for by the address takes precedence over the divider.
    if (!conversationId || !unreadAnchor || focusRun || positionedRef.current === conversationId) return
    const el = document.getElementById(UNREAD_ANCHOR_ID)
    if (!el) return
    positionedRef.current = conversationId
    el.scrollIntoView({ block: 'start' })
    pinnedRef.current = false
    recordAnchor()
    seenRef.current = finishedCount - unreadCount
    setAwayFromBottom(true)
  }, [conversationId, unreadAnchor, messages.length, focusRun])

  const newBelow = awayFromBottom ? Math.max(0, finishedCount - seenRef.current) : 0

  // A jump, not a glide: a smooth scroll aims at where the bottom was when it
  // started and lands short of it if the answer grew meanwhile.
  function scrollToBottom() {
    pinToBottom()
  }

  // Opened by mistake, or to come back to: unread again from this answer, and
  // on Today until the chat is opened again — staying here doesn't read it.
  // Stable, so the bubbles stay memoized.
  const markUnread = useCallback(async (messageId: string) => {
    if (!conversationId) return
    try {
      await useChatStore.getState().markUnreadFrom(conversationId, messageId)
    } catch {
      window.__jarvisToast?.error("Couldn't mark it unread — try again.")
    }
  }, [conversationId])
  const canMarkUnread = !shared && !embedded

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

  function sendMessage(text: string, attachments: Attachment[] = [], answers?: Record<string, string>) {
    if (!conversationId) return

    if (composerAnswers && pending) {
      void answerFromComposer(conversationId, pending, text.trim(), attachments, answers)
      return
    }
    if (!text.trim() && attachments.length === 0) return

    api
      .sendMessage(conversationId, text, attachments.length > 0 ? attachments : undefined, model, effort, quote)
      .catch((err) => {
        console.error('Failed to send message:', err)
      })
    useChatStore.getState().rememberModel(conversationId, model, effort)
    setQuote(null)
  }

  async function sendAudio(audioBlob: Blob, { text, files }: VoiceExtras) {
    if (!conversationId) return
    const attachments = await settleUploads(files)
    if (attachments.length < files.length) window.__jarvisToast?.error("A file couldn't be uploaded — sent without it.")
    if (composerAnswers && pending) {
      // Dictated answer: transcribe here, then answer with the words.
      const { transcript } = await api.transcribeAudio(audioBlob)
      const words = spoken(text, transcript)
      if (words || attachments.length) await answerFromComposer(conversationId, pending, words, attachments)
      return
    }
    const replyTo = quote
    setQuote(null)
    // The bubble lands as the transcription ends, without waiting on the stream.
    const { message } = await api.sendAudio(conversationId, audioBlob, { model, effort, text, attachments, replyTo })
    useChatStore.getState().upsertMessage(conversationId, message)
    useChatStore.getState().rememberModel(conversationId, model, effort)
  }

  function handleNotifyChange(mode: Conversation['notify']) {
    if (!conversationId) return
    useChatStore.getState().patchConversation(conversationId, { notify: mode })
  }

  function handleModelChange(newModel: string) {
    if (!conversationId) return
    setPicked({ id: conversationId, model: newModel, effort })
  }

  function handleEffortChange(newEffort: Conversation['effort']) {
    if (!conversationId) return
    setPicked({ id: conversationId, model, effort: newEffort })
  }

  function handleMove(newSectionId: string | null) {
    if (!conversationId || !confirmThreadMove(conv)) return
    useChatStore
      .getState()
      .patchConversation(conversationId, { section_id: newSectionId })
  }

  function startRename() {
    setRenameValue(conv?.title ?? '')
    setRenaming(true)
  }

  async function submitRename() {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== conv?.title && conversationId) {
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

  const paneToggle = (
    <span className='flex gap-0.5 bg-surface2 rounded-lg p-0.5 shrink-0'>
      {(['chat', 'app'] as const).map((pane) => {
        const on = pane === 'chat' ? chatShown : appShown
        return (
          <button
            key={pane}
            onClick={() => togglePane(pane)}
            aria-pressed={on}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${on ? 'bg-bg text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}
          >
            {pane === 'chat' ? 'Chat' : hasApp ? 'App' : tabs.length ? 'Docs' : 'Threads'}
          </button>
        )
      })}
    </span>
  )

  // The way back to this chat's threads, whatever was said since.
  const threadsPill = !isThread && !shared && !embedded && conversationId && (messages.length > 0 || subChats.length > 0 || routineThreads.length > 0) ? (
    <ThreadsPill
      conversationId={conversationId}
      threads={subChats}
      routines={routineThreads}
      messages={messages}
      activeId={openThreadId}
      onOpen={openThread}
      onNew={() => setNewThread({ convId: conversationId, quote: null })}
      onArchive={(t, archived) => archiveThread(t.id, archived)}
    />
  ) : null
  // A thread that answered while you were here: one tap away, above the composer.
  const threadNews = subChats
    .filter((t) => t.unread_count > 0 && t.id !== openThreadId && isActiveThread(t))
    .sort((a, b) => b.updated_at - a.updated_at)

  const desktopTitle = (
    <ContentTitle
      action={conversationId && !shared ? (
        <span className='flex items-center gap-2'>
          {isThread ? (routine && conv && <RoutineChip routine={routine} thread={conv} onChanged={reloadRoutine} defaultOpen={routineOpen} />) : <>{threadsPill}<RunsPill conversationId={conversationId} /></>}
          <ShareIcon shareMode={shareMode} />
          <ContextGauge tokens={contextTokens} windowTokens={contextWindow} />
          <ConversationMenu onDelete={handleDelete} onRename={startRename} notify={notify} onNotifyChange={notifiesThroughParent ? undefined : handleNotifyChange} conversationId={conversationId} onMove={() => setMoving(true)} onRefreshApp={hasApp ? bumpApp : undefined} appUrl={hasApp ? appShareUrl : undefined} onRotateAppToken={hasApp && conversationId ? async () => { const { token } = await api.rotateAppToken(conversationId); setAppShare({ id: conversationId, token }) } : undefined} />
        </span>
      ) : undefined}
    >
      {sidePane === 'app' ? (
        <span className='flex items-center gap-3'>
          <span className='truncate flex-1'>{title}</span>
          {paneToggle}
        </span>
      ) : title}
    </ContentTitle>
  )

  return (
    <PanelOpenerContext.Provider value={withTabs && conversationId ? openFile : null}>
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
        currentId={isThread ? THREAD_GROUP : sectionId}
        onPick={handleMove}
        onClose={() => setMoving(false)}
      />
    )}
    <div className='flex flex-col h-full'>
      {/* Mobile title bar + toggle — above both panes */}
      {title && !embedded && !(threadPanel && !isDesktop) && (
        <div className='md:hidden'>
          <ContentTitle
            action={conversationId && !shared ? (
              <span className='flex items-center gap-2'>
                {isThread ? (routine && conv && <RoutineChip routine={routine} thread={conv} onChanged={reloadRoutine} defaultOpen={routineOpen} />) : <>{threadsPill}<RunsPill conversationId={conversationId} /></>}
                <ShareIcon shareMode={shareMode} />
                <ContextGauge tokens={contextTokens} windowTokens={contextWindow} />
                <ConversationMenu onDelete={handleDelete} onRename={startRename} notify={notify} onNotifyChange={notifiesThroughParent ? undefined : handleNotifyChange} conversationId={conversationId} onMove={() => setMoving(true)} onRefreshApp={hasApp ? bumpApp : undefined} appUrl={hasApp ? appShareUrl : undefined} onRotateAppToken={hasApp && conversationId ? async () => { const { token } = await api.rotateAppToken(conversationId); setAppShare({ id: conversationId, token }) } : undefined} />
              </span>
            ) : undefined}
          >
            <span className='flex items-center gap-3'>
              <span className='truncate flex-1'>{title}</span>
              {hasPanel && paneToggle}
            </span>
          </ContentTitle>
        </div>
      )}

      {/* Panes */}
      <div ref={splitRef} className='flex flex-1 min-h-0'>
        {/* Chat pane — takes whatever the app pane leaves on desktop */}
        <div
          className={`flex flex-col h-full min-w-0 ${
            !chatShown ? 'hidden'
              : appShown ? 'flex flex-1 border-r border-border'
              : 'flex w-full'
          }`}
        >
          {/* Desktop title — inside chat pane so preview gets full height */}
          {title && !embedded && <div className='hidden md:block'>{desktopTitle}</div>}


          {/* Messages */}
          <div ref={paneRef} className='relative flex-1 min-h-0'>
            {!shared?.readOnly && (
              <SelectionReply
                paneRef={paneRef}
                onQuote={setQuote}
                onThread={embedded || shared ? undefined : (q) => conversationId && setNewThread({ convId: conversationId, quote: q })}
              />
            )}
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
                    {/* A routine being set up: its card is the form, where the
                        conversation starts. Once it exists, the card lives behind
                        the title bar's chip instead. */}
                    {isThread && conv && !shared && !routine && isDraftThread(conv) && (
                      <RoutineCard routine={null} thread={conv} onChanged={reloadRoutine} />
                    )}
                    {/* A thread is where its runs are kept, the silent ones included:
                        it is the record a report links back to. */}
                    {(isThread ? groupMessagesByDay(messages, unreadAnchor) : dropQuietRuns(groupMessagesByDay(messages, unreadAnchor), runsById)).map((item) =>
                      item.type === 'separator' ? (
                        <DateSeparator key={item.key} label={item.label} />
                      ) : item.type === 'unread' ? (
                        <UnreadSeparator key={item.key} onDismiss={dismissUnread} />
                      ) : item.type === 'report' ? (
                        <RunReportCard key={item.key} msg={item.msg} report={item.report} onMarkUnread={canMarkUnread ? markUnread : undefined} />
                      ) : item.type === 'reportStack' ? (
                        <RunReportStack key={item.key} entries={item.entries} />
                      ) : item.type === 'runBlock' ? (
                        <div
                          key={item.key}
                          data-run-id={item.runId}
                          // The run asked for: a mark in the margin, as a reader
                          // would pencil one, under a tint that fades.
                          className={item.runId === focusRun
                            ? `relative -mx-4 rounded-r-xl px-4 transition-colors duration-[1500ms] before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-accent/70 ${runLit ? 'bg-accent/[0.07]' : 'bg-transparent'}`
                            : undefined}
                        >
                          <RunBlock
                            run={runsById.get(item.runId)}
                            msgs={item.msgs}
                            live={isProcessing && item.msgs.some((m) => m.id === lastMessageId)}
                            lastMessageId={lastMessageId}
                            inOwnThread={isThread}
                            onMarkUnread={canMarkUnread ? markUnread : undefined}
                          />
                          {threadMarks(item.msgs.map((m) => m.id))}
                        </div>
                      ) : (
                        <Fragment key={item.msg.id}>
                          <MessageBubble
                            msg={item.msg}
                            // The newest message while a turn runs is the one
                            // being written, and it shows the step it is on.
                            live={isProcessing && item.msg.id === lastMessageId}
                            modelLabel={modelLabels.get(item.msg.id)}
                            onMarkUnread={canMarkUnread ? markUnread : undefined}
                          />
                          {threadMarks([item.msg.id])}
                        </Fragment>
                      ),
                    )}
                    {outgoing?.kind === 'message' && <OutgoingBubble outgoing={outgoing} />}
                    <LiveTurn conversationId={conversationId} />
                    {/* Parked is not thinking: the loader rests while he waits on you.
                        The question itself sits on the composer, below. */}
                    <JarvisIndicator isThinking={isProcessing && !pending} live={isProcessing ? messages[messages.length - 1] : undefined} />
                  </>
                )}
              </div>
            </div>
          </div>

          {threadNews.length > 0 && (
            <div className='flex justify-center px-4 pb-1'>
              <button
                type='button'
                onClick={() => openThread(threadNews[0].id)}
                data-testid='thread-news'
                className='inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent/30 bg-surface px-3 py-1 text-[12px] text-text-secondary shadow-sm transition-colors hover:border-accent/60 hover:text-text-primary'
              >
                <Hash size={12} className='shrink-0 text-accent' />
                <span className='truncate'><span className='font-medium text-text-primary'>{threadNews[0].title}</span> replied</span>
                <span className='shrink-0 rounded-full bg-accent px-1.5 text-[10.5px] font-medium text-white'>{threadNews[0].unread_count} new</span>
                {threadNews.length > 1 && <span className='shrink-0 text-text-muted'>+{threadNews.length - 1} more</span>}
              </button>
            </div>
          )}

          {/* Input — absent on a read-only link, present on an editable one */}
          {!shared?.readOnly && (
          <ChatInput
            // One per chat: what is recording or half-picked in one never
            // carries into the next. The draft itself lives in lib/drafts.
            key={conversationId}
            onSend={sendMessage}
            onSendAudio={sendAudio}
            transcribing={outgoing?.kind === 'voice'}
            onCancel={cancelMessage}
            isProcessing={isProcessing}
            conversationId={conversationId}
            autoFocus={!showSkeleton && messages.length === 0}
            question={!shared?.readOnly && pending ? pending : undefined}
            placeholder={isDraftThread(conv) ? 'Or describe the routine you want — Jarvis sets it up…' : embedded ? 'Reply in the thread…' : undefined}
            initialText={initialMessage || undefined}
            initialFiles={initialFiles || undefined}
            onInitialFilesConsumed={onInitialFilesConsumed}
            quote={quote}
            onClearQuote={() => setQuote(null)}
            // A share link talks to the chat but doesn't choose what it runs
            // on (the backend ignores its pick too).
            model={shared ? undefined : model}
            effort={effort}
            onModelChange={handleModelChange}
            onEffortChange={handleEffortChange}
          />
          )}
        </div>

        {/* Side pane: the app, documents, links and threads, as tabs */}
        {isDesktop && appShown && chatShown && (
          <ResizeHandle
            label='Resize the side panel'
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

        {sidePane === 'app' && (
          // Hidden rather than unmounted, so the app keeps its state while away.
          <div
            className={`${appShown ? 'flex' : 'hidden'} flex-col h-full min-w-0 ${chatShown ? 'shrink-0' : 'flex-1'}`}
            // Only beside the chat: alone, it takes the full width, so a share
            // of a split it isn't part of would just break it.
            style={chatShown ? { width: `${appPct}%` } : undefined}
          >
            {/* The app alone on desktop: the title comes along, toggle included */}
            {isDesktop && !chatShown && title && desktopTitle}
            {hasApp && tabs.length === 0 && threadTabs.length === 0 ? (
              <AppPreview
                appSlug={conv!.app_path!.replace(/^apps\//, '')}
                appToken={appShareToken}
                refreshKey={appRefreshKey}
                onRefresh={bumpApp}
                shareIntent={shareIntent}
                onShareIntentConsumed={onShareIntentConsumed}
                // Alone, the title bar above it is its bar: refresh and open are in its ··· menu, as on a phone.
                toolbar={chatShown}
                conversationId={conversationId}
                onCall={withTabs ? handleAppCall : undefined}
              />
            ) : (
              <SidePanel
                conversationId={conversationId!}
                tabs={tabs}
                active={panelKey}
                onActivate={activate}
                topicId={conv?.section_id ?? null}
                threads={threadTabs}
                onCloseThread={closeThreadTab}
                onThreadDone={(id) => archiveThread(id, true)}
                // A phone shows the thread instead of the chat, title bar included: the way back is in the strip.
                onBack={!isDesktop && threadKey ? () => (threadKey === 'thread:new' ? setNewThread(null) : openThread(null)) : undefined}
                renderThread={(key) => conversationId && (
                  <ThreadPanel
                    key={key}
                    parentId={conversationId}
                    state={key === 'thread:new' ? { kind: 'new', quote: newThread?.quote ?? null } : { kind: 'open', id: key.slice('thread:'.length) }}
                    onOpened={(id) => openThread(id)}
                  />
                )}
                app={hasApp ? {
                  onRefresh: bumpApp,
                  url: appShareUrl,
                  node: (
                    <AppPreview
                      appSlug={conv!.app_path!.replace(/^apps\//, '')}
                      appToken={appShareToken}
                      refreshKey={appRefreshKey}
                      onRefresh={bumpApp}
                      shareIntent={shareIntent}
                      onShareIntentConsumed={onShareIntentConsumed}
                      toolbar={false}
                      conversationId={conversationId}
                      onCall={withTabs ? handleAppCall : undefined}
                    />
                  ),
                } : undefined}
              />
            )}
          </div>
        )}
      </div>
    </div>
    </PanelOpenerContext.Provider>
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

/**
 * The first message of a chat started from Today, drawn like the bubble it
 * becomes while its files finish uploading — each one spinning until it is up.
 * The saved message replaces it (lib/outbox).
 */
function OutgoingBubble({ outgoing }: { outgoing: Extract<Outgoing, { kind: 'message' }> }) {
  return (
    <div data-testid='outgoing-message' className='flex justify-end mb-5 animate-fade-in'>
      <div className='max-w-[75%] break-words bg-accent-subtle text-text-primary rounded-2xl rounded-br-md px-4 py-3 text-base leading-relaxed'>
        {outgoing.files.length > 0 && (
          <div className={`flex flex-wrap gap-2 ${outgoing.text.trim() ? 'mb-2' : ''}`}>
            {outgoing.files.map((f, i) => (
              <div key={i} className='relative'>
                {f.preview ? (
                  <img src={f.preview} alt={f.name} className='max-w-[240px] max-h-[200px] rounded-lg object-cover border border-border' />
                ) : (
                  <div className='flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-bg'>
                    <FileText size={16} className='text-text-muted shrink-0' />
                    <span className='text-xs text-text-primary truncate max-w-[180px]'>{f.name}</span>
                  </div>
                )}
                {f.uploading && (
                  <div data-testid='outgoing-uploading' className='absolute inset-0 flex items-center justify-center rounded-lg bg-black/40'>
                    <Loader2 size={18} className='animate-spin text-white' />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {outgoing.text.trim() && <p className='whitespace-pre-wrap'>{outgoing.text.trim()}</p>}
      </div>
    </div>
  )
}

/**
 * The Jarvis loader at the foot of the list. While a turn runs it is the
 * spinner: what he is on sits next to it. No time until the turn ends.
 */
function JarvisIndicator({ isThinking, live }: { isThinking: boolean; live?: Message }) {
  const [staticFrame, setStaticFrame] = useState<string | null>(null)
  const status = useMemo(() => (isThinking && live ? liveStatus(live) : null), [isThinking, live])

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
    <div data-testid='jarvis-indicator' className='mb-3'>
      <div className='flex items-center gap-2'>
        <img
          key={isThinking ? 'thinking' : 'idle'}
          src={isThinking ? `${BASE_PATH}/images/jarvis_loading.gif` : (staticFrame || `${BASE_PATH}/images/jarvis_loading.gif`)}
          alt='Jarvis'
          className='w-10 h-10 shrink-0 mix-blend-multiply dark:mix-blend-screen'
        />
        {status && (
          <div data-testid='live-status' className='min-w-0 flex-1 text-[13px] leading-relaxed text-text-muted'>
            {status.note ? (
              <Markdown text={status.note} />
            ) : (
              <span className='line-clamp-1'>{status.tool ?? 'Working…'}</span>
            )}
          </div>
        )}
      </div>
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

/**
 * Under a message a thread was started from: the way into it, as Slack's
 * "3 replies" — its name, and whether something new landed there.
 */
function ThreadMarks({ threads, openId, onOpen }: { threads: Conversation[]; openId: string | null; onOpen: (id: string) => void }) {
  return (
    <div className='-mt-3 mb-5 flex flex-col items-start gap-1' data-testid='thread-marks'>
      {threads.map((t) => {
        const unread = t.unread_count > 0 && t.id !== openId
        return (
          <button
            key={t.id}
            type='button'
            onClick={() => onOpen(t.id)}
            className={`group inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] transition-colors ${t.id === openId ? 'border-accent/40 bg-accent/5 text-text-primary' : 'border-border text-text-secondary hover:border-accent/40 hover:bg-surface2'}`}
          >
            <Hash size={12} className='shrink-0 text-accent' />
            <span className='truncate'>{t.title}</span>
            {unread ? (
              <span className='shrink-0 rounded-full bg-accent px-1.5 text-[10.5px] font-medium text-white'>{t.unread_count} new</span>
            ) : (
              <span className='shrink-0 text-text-muted'>· {new Date(t.updated_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
