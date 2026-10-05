import { useState, useEffect, useRef } from 'react'
import RoutinesPage from './RoutinesPage'
import NewRoutinePage from './NewRoutinePage'
import TopicPage from './TopicPage'
import TodayPage from './TodayPage'
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom'
import Sidebar from '../components/Sidebar'
import ResizeHandle from '../components/ResizeHandle'
import { useIsDesktop } from '../hooks/useIsDesktop'
import ChatView from '../components/ChatView'
import CodeBrowser from '../components/CodeBrowser'
import BrowserPage from '../components/BrowserPage'
import UpdateBanner from '../components/UpdateBanner'
import SettingsPage from './SettingsPage'
import CustomizePage from './CustomizePage'
import {
  SidebarToggleProvider,
  SidebarToggle,
} from '../components/ContentLayout'
import { api } from '../api'
import ShareHandler from '../components/ShareHandler'
import { useChatStore } from '../stores/chatStore'
import { isListed } from '../lib/threads'
import { useServiceWorker } from '../hooks/useServiceWorker'
import { useGlobalEvents } from '../hooks/useGlobalEvents'
import { loadModelCatalogue } from '../components/ModelSelector'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { useSwipeToOpen } from '../hooks/useSwipeToOpen'

export default function ChatPage() {
  const listLoaded = useChatStore((s) => s.listLoaded)
  const hasUnread = useChatStore((s) =>
    s.order.some((id) => {
      const c = s.conversations[id]
      return !!c && isListed(c) && (c.unread_count ?? 0) > 0
    }),
  )
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sharedMessage, setSharedMessage] = useState<string | null>(null)
  const [sharedFiles, setSharedFiles] = useState<File[] | null>(null)
  const [shareIntent, setShareIntent] = useState<{
    title?: string; text?: string; url?: string; files?: File[]
  } | null>(null)
  const navigate = useNavigate()
  const location = useLocation()
  useServiceWorker()
  useGlobalEvents()

  const isDesktop = useIsDesktop()
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const sidebarDragFrom = useRef(sidebarWidth)

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_W_KEY, String(sidebarWidth))
    } catch {
      /* private window, or site data blocked — the width just won't persist */
    }
  }, [sidebarWidth])

  // The swipe-to-open hook drives the mobile overlay, which is always w-64 —
  // a width dragged on a laptop must not change how far a phone has to swipe.
  const { containerRef, sidebarRef, overlayRef, handlers: swipeHandlers } = useSwipeToOpen({
    onOpen: () => setSidebarOpen(true),
    onClose: () => setSidebarOpen(false),
    isOpen: sidebarOpen,
    sidebarWidth: SIDEBAR_DEFAULT_W,
  })

  const locationRef = useRef(location.pathname)
  useEffect(() => { locationRef.current = location.pathname }, [location.pathname])

  useKeyboardShortcuts([
    { key: 'n', meta: true, action: newConversation, description: 'New chat' },
    { key: 'n', meta: true, shift: true, action: newConversation, description: 'New chat' },
  ])

  useEffect(() => {
    // Establish the media cookie before anything renders inline files.
    api.syncSessionCookie()

    // The picker's options depend on the active provider, so they come from the
    // server rather than a compiled-in constant.
    loadModelCatalogue(() => api.getModels())

    api.getMe().then(({ onboarded }) => {
      if (!onboarded) navigate('/onboarding', { replace: true })
    }).catch(() => {})

    const store = useChatStore.getState()
    store.loadSections()
    store.loadConversations().then(() => {
      const match = locationRef.current.match(/^\/c\/(.+)$/)
      if (match) store.markRead(match[1])
    })
  }, [])

  // A new chat is Today's composer: nothing is created until something is
  // sent, so opening one and walking away leaves nothing behind. The state is a
  // fresh token each time, so a second press while already on Today still
  // focuses the input.
  function newConversation() {
    navigate('/', { state: { compose: Date.now() } })
    setSidebarOpen(false)
  }

  // Optimistically clear unread count + dismiss notifications when navigating to a conversation
  useEffect(() => {
    const match = location.pathname.match(/^\/c\/(.+)$/)
    if (match) {
      const convId = match[1]
      useChatStore.getState().markRead(convId)
      navigator.serviceWorker?.ready.then((reg) =>
        reg.getNotifications({ tag: `jarvis-/c/${convId}` }).then((ns) =>
          ns.forEach((n) => n.close()),
        ),
      )
    }
  }, [location.pathname])

  return (
    <div
      ref={containerRef}
      className='flex bg-bg app-shell'
      {...swipeHandlers}
    >
      {/* Overlay — always mounted; React controls it at rest, hook drives it during swipe */}
      <div
        ref={overlayRef}
        className='md:hidden fixed inset-0 bg-black z-30 backdrop-blur-sm transition-opacity duration-200'
        style={{ opacity: sidebarOpen ? 0.6 : 0, pointerEvents: sidebarOpen ? 'auto' : 'none' }}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Sidebar — ref lets the hook drive transform directly, no re-renders during drag */}
      <div
        ref={sidebarRef}
        className={`fixed md:relative z-40 h-full will-change-transform transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
      >
        <Sidebar
          onNew={newConversation}
          onDelete={async (id, opts) => {
            const onCurrent = locationRef.current === `/c/${id}`
            await useChatStore.getState().deleteConversation(id, opts)
            if (onCurrent) navigate('/', { replace: true })
          }}
          onRename={(id, title) => useChatStore.getState().patchConversation(id, { title })}
          onMove={(id, sectionId) =>
            useChatStore.getState().patchConversation(id, { section_id: sectionId })
          }
          onSelect={() => setSidebarOpen(false)}
          width={isDesktop ? sidebarWidth : undefined}
        />
      </div>

      {isDesktop && (
        <ResizeHandle
          label='Resize sidebar'
          onStart={() => {
            sidebarDragFrom.current = sidebarWidth
          }}
          onMove={(dx) =>
            setSidebarWidth(
              Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, sidebarDragFrom.current + dx)),
            )
          }
          onReset={() => setSidebarWidth(SIDEBAR_DEFAULT_W)}
        />
      )}

      <main className='flex-1 min-w-0 overflow-hidden flex flex-col'>
        <SidebarToggleProvider value={{ onToggle: () => setSidebarOpen(true), hasUnread }}>
          <Routes>
            <Route
              path='/'
              element={
                listLoaded ? (
                  <TodayPage />
                ) : (
                  <LoadingScreen />
                )
              }
            />
            <Route
              path='/share'
              element={
                <ShareHandler
                  onReady={(convId, message, files) => {
                    setSharedMessage(message || null)
                    if (files && files.length > 0) setSharedFiles(files)
                    useChatStore.getState().loadConversations()
                    navigate(`/c/${convId}`, { replace: true })
                  }}
                  onAppPick={(convId, intent) => {
                    setShareIntent(intent)
                    useChatStore.getState().loadConversations()
                    navigate(`/c/${convId}`, { replace: true })
                  }}
                  onAutoSent={(convId) => {
                    // Audio was already uploaded + sent — just open the conversation
                    useChatStore.getState().loadConversations()
                    navigate(`/c/${convId}`, { replace: true })
                  }}
                />
              }
            />
            <Route
              path='/c/:id'
              element={
                <ChatView
                  initialMessage={sharedMessage}
                  onInitialMessageConsumed={() => setSharedMessage(null)}
                  initialFiles={sharedFiles}
                  onInitialFilesConsumed={() => setSharedFiles(null)}
                  shareIntent={shareIntent}
                  onShareIntentConsumed={() => setShareIntent(null)}
                />
              }
            />
            <Route path='/routines' element={<RoutinesPage />} />
            <Route path='/routines/new' element={<NewRoutinePage />} />
            <Route path='/t/:id' element={<TopicPage />} />
            {/* Crons and webhooks became routines, and the Activity page folded into
                Today and the chats; the old addresses still land. */}
            <Route path='/activity' element={<LegacyRoutinesRedirect />} />
            <Route path='/crons' element={<LegacyRoutinesRedirect />} />
            <Route path='/webhooks' element={<LegacyRoutinesRedirect />} />
            <Route path='/settings' element={<SettingsPage />} />
            <Route path='/settings/customize' element={<CustomizePage />} />
            {/* Older settings addresses still land where their content went. */}
            <Route path='/connectors' element={<Navigate to='/settings/customize?tab=connectors' replace />} />
            <Route path='/connection' element={<Navigate to='/settings/customize' replace />} />
            <Route path='/api-keys' element={<Navigate to='/settings' replace />} />
            <Route path='/plugins' element={<Navigate to='/settings' replace />} />
            {/* Full-height tools, reached from the Settings menu. */}
            <Route path='/browser' element={<BrowserPage />} />
            <Route path='/code/*' element={<CodeBrowser />} />
          </Routes>
        </SidebarToggleProvider>
      </main>

      <UpdateBanner />
    </div>
  )
}

/** The width the sidebar has always been, and what double-click returns to. */
export const SIDEBAR_DEFAULT_W = 256 // w-64
const SIDEBAR_MIN_W = 190
const SIDEBAR_MAX_W = 460
const SIDEBAR_W_KEY = 'sidebar-width'

function readSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_W_KEY))
    // Anything outside the range is treated as absent rather than clamped: a
    // stored 4000 is corruption, not a preference.
    return raw >= SIDEBAR_MIN_W && raw <= SIDEBAR_MAX_W ? raw : SIDEBAR_DEFAULT_W
  } catch {
    return SIDEBAR_DEFAULT_W
  }
}

function LoadingScreen() {
  return (
    <div className='flex items-center justify-center h-full'>
      <div className='animate-pulse-soft text-text-muted text-sm'>
        Loading...
      </div>
    </div>
  )
}

/** /activity, /crons and /webhooks, carrying their ?conversation_id= or ?edit= into Routines. */
function LegacyRoutinesRedirect() {
  const { search } = useLocation()
  const p = new URLSearchParams(search)
  p.delete('tab')
  const qs = p.toString()
  return <Navigate to={`/routines${qs ? `?${qs}` : ''}`} replace />
}
