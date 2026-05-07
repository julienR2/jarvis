import { useState, useEffect, useRef } from 'react'
import {
  Routes,
  Route,
  useNavigate,
  useLocation,
  useSearchParams,
} from 'react-router-dom'
import { Plus, MessageSquare, FileText, X, AppWindow, Layers, Clock, Link2 } from 'lucide-react'
import Sidebar from '../components/Sidebar'
import ChatView, { invalidateConvCache } from '../components/ChatView'
import CronManager from '../components/CronManager'
import WebhookManager from '../components/WebhookManager'
import FileBrowser from '../components/FileBrowser'
import ConnectorsPage from '../components/ConnectorsPage'
import {
  SidebarToggleProvider,
  SidebarToggle,
} from '../components/ContentLayout'
import { api, connectGlobalEvents, type Conversation, type GlobalEvent } from '../api'
import { useServiceWorker } from '../hooks/useServiceWorker'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { useSwipeToOpen } from '../hooks/useSwipeToOpen'

export default function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [sharedMessage, setSharedMessage] = useState<string | null>(null)
  const [sharedFiles, setSharedFiles] = useState<File[] | null>(null)
  const navigate = useNavigate()
  const location = useLocation()
  useServiceWorker()
  const isSharePage = location.pathname === '/share'

  const SIDEBAR_W = 256 // w-64
  const { containerRef, sidebarRef, overlayRef, handlers: swipeHandlers } = useSwipeToOpen({
    onOpen: () => setSidebarOpen(true),
    onClose: () => setSidebarOpen(false),
    isOpen: sidebarOpen,
    sidebarWidth: SIDEBAR_W,
  })

  const locationRef = useRef(location.pathname)
  useEffect(() => { locationRef.current = location.pathname }, [location.pathname])

  useKeyboardShortcuts([
    { key: 'n', meta: true, action: newConversation, description: 'New chat' },
  ])

  async function loadConversations() {
    try {
      const list = await api.getConversations()
      // Keep unread_count at 0 for the conversation we're currently viewing
      const match = locationRef.current.match(/^\/c\/(.+)$/)
      if (match) {
        const currentId = match[1]
        setConversations(list.map((c) => c.id === currentId ? { ...c, unread_count: 0 } : c))
      } else {
        setConversations(list)
      }
      return list
    } catch {
      return []
    }
  }

  useEffect(() => {
    loadConversations().then(() => {
      setLoaded(true)
    })

    // Refresh conversation list when returning to the app (SSE may have dropped while backgrounded)
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        loadConversations()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Subscribe to global SSE for real-time unread updates
    const conn = connectGlobalEvents((ev) => {
      if (ev.type === 'new_message') {
        const currentMatch = locationRef.current.match(/^\/c\/(.+)$/)
        const currentId = currentMatch?.[1]
        if (ev.conversation_id === currentId) return // user is viewing this conversation

        setConversations((prev) => {
          const exists = prev.some((c) => c.id === ev.conversation_id)
          if (!exists) {
            // New conversation (e.g. from cron) — refresh the full list
            loadConversations()
            return prev
          }
          return prev.map((c) =>
            c.id === ev.conversation_id ? { ...c, unread_count: c.unread_count + 1 } : c,
          )
        })
      }
    })

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      conn.close()
    }
  }, [])

  async function newConversation() {
    const conv = await api.createConversation()
    setConversations((prev) => [conv, ...prev])
    navigate(`/c/${conv.id}`)
    setSidebarOpen(false)
  }

  // Optimistically clear unread count + dismiss notifications when navigating to a conversation
  useEffect(() => {
    const match = location.pathname.match(/^\/c\/(.+)$/)
    if (match) {
      const convId = match[1]
      setConversations((prev) =>
        prev.map((c) => c.id === convId ? { ...c, unread_count: 0 } : c),
      )
      navigator.serviceWorker?.ready.then((reg) =>
        reg.getNotifications({ tag: `jarvis-/c/${convId}` }).then((ns) =>
          ns.forEach((n) => n.close()),
        ),
      )
    }
  }, [location.pathname])

  function updateConversationTitle(id: string, title: string) {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c)),
    )
  }

  function removeConversation(id: string) {
    setConversations((prev) => prev.filter((c) => c.id !== id))
    navigate('/')
  }

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
          conversations={conversations}
          onNew={newConversation}
          onDelete={async (id) => {
            invalidateConvCache(id)
            await api.deleteConversation(id)
            removeConversation(id)
          }}
          onRename={async (id, title) => {
            await api.updateConversation(id, { title })
            updateConversationTitle(id, title)
          }}
          onSelect={() => setSidebarOpen(false)}
        />
      </div>

      <main className='flex-1 overflow-hidden flex flex-col'>
        <SidebarToggleProvider value={{ onToggle: () => setSidebarOpen(true), hasUnread: conversations.some((c) => c.unread_count > 0) }}>
          <Routes>
            <Route
              path='/'
              element={
                loaded ? (
                  <Welcome
                    onNew={newConversation}
                    conversations={conversations}
                  />
                ) : (
                  <LoadingScreen />
                )
              }
            />
            <Route
              path='/share'
              element={
                <ShareHandler
                  conversations={conversations}
                  onReady={(convId, message, files) => {
                    setSharedMessage(message || null)
                    if (files && files.length > 0) setSharedFiles(files)
                    loadConversations()
                    navigate(`/c/${convId}`, { replace: true })
                  }}
                />
              }
            />
            <Route
              path='/c/:id'
              element={
                <ChatView
                  onTitleChange={updateConversationTitle}
                  onRefreshList={loadConversations}
                  onDelete={async (id) => { invalidateConvCache(id); await api.deleteConversation(id); removeConversation(id) }}
                  initialMessage={sharedMessage}
                  onInitialMessageConsumed={() => setSharedMessage(null)}
                  initialFiles={sharedFiles}
                  onInitialFilesConsumed={() => setSharedFiles(null)}
                />
              }
            />
            <Route path='/crons' element={<CronManager />} />
            <Route path='/webhooks' element={<WebhookManager />} />
            <Route path='/connectors' element={<ConnectorsPage />} />
            <Route path='/files/*' element={<FileBrowser />} />
          </Routes>
        </SidebarToggleProvider>
      </main>
    </div>
  )
}

// Get greeting based on time of day
function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function Welcome({
  onNew,
  conversations,
}: {
  onNew: () => void
  conversations: Conversation[]
}) {
  const navigate = useNavigate()
  const spaces = conversations.filter((c) => c.mini_app_path || c.has_cron || c.has_webhook)

  return (
    <div className='flex flex-col h-full overflow-y-auto'>
      <div className='px-3 pt-3'>
        <SidebarToggle />
      </div>
      {/* Hero */}
      <div className='flex flex-col items-center pt-8 pb-8 px-4 mt-5'>
        <div className='flex items-center gap-2 mb-4'>
          <img
            src='/images/jarvis_wave.gif'
            alt='Jarvis'
            className='w-24 h-24 mix-blend-multiply dark:mix-blend-screen'
          />
        </div>
        <h1 className='text-2xl md:text-3xl font-light text-text-primary'>
          {getGreeting()}
        </h1>
        <p className='text-text-muted text-sm mt-1 mb-6'>
          How can I help you today?
        </p>
        <button
          onClick={onNew}
          className='flex items-center gap-2 bg-accent text-white px-5 py-2.5 rounded-xl font-medium hover:bg-accent-hover transition-colors'
        >
          <Plus size={18} />
          New conversation
        </button>
      </div>

      {/* Spaces grid */}
      {spaces.length > 0 && (
        <div className='max-w-2xl w-full mx-auto px-4 pb-8 mt-2'>
          <h2 className='text-xs font-medium text-text-muted uppercase tracking-wider mb-3 flex items-center gap-1.5'>
            <Layers size={13} />
            Spaces
          </h2>
          <div className='grid grid-cols-2 md:grid-cols-3 gap-3'>
            {spaces.map((space) => (
              <button
                key={space.id}
                onClick={() => navigate(`/c/${space.id}`)}
                className='flex flex-col gap-2 px-4 py-3 rounded-xl bg-surface border border-border hover:border-accent/40 hover:bg-surface2 transition-colors text-left'
              >
                <span className='flex items-center justify-between gap-1.5'>
                  <span className='flex items-center gap-1.5 text-text-muted'>
                    {!!space.mini_app_path && <AppWindow size={13} />}
                    {!!space.has_cron && <Clock size={13} />}
                    {!!space.has_webhook && <Link2 size={13} />}
                  </span>
                  {space.unread_count > 0 && (
                    <span className='min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-accent text-white text-[11px] font-medium'>
                      {space.unread_count}
                    </span>
                  )}
                </span>
                <span className='text-sm text-text-primary truncate'>
                  {space.title}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
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

async function retrieveSharedFiles(): Promise<File[]> {
  try {
    const cache = await caches.open('shared-files')
    const keys = await cache.keys()
    const files: File[] = []

    for (const key of keys) {
      const response = await cache.match(key)
      if (!response) continue
      const blob = await response.blob()
      const originalName = decodeURIComponent(
        response.headers.get('X-Original-Name') || 'shared-file',
      )
      files.push(new File([blob], originalName, { type: blob.type }))
      await cache.delete(key)
    }

    return files
  } catch {
    return []
  }
}

function ShareHandler({
  conversations,
  onReady,
}: {
  conversations: Conversation[]
  onReady: (convId: string, message: string, files?: File[]) => void
}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [message, setMessage] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const initialized = useRef(false)

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const title = searchParams.get('title') || ''
    const text = searchParams.get('text') || ''
    const url = searchParams.get('url') || ''
    const hasFiles = parseInt(searchParams.get('hasFiles') || '0', 10)

    const parts = [title, text, url].filter(Boolean)
    setMessage(parts.join('\n') || '')

    if (hasFiles > 0) {
      retrieveSharedFiles().then((f) => {
        setFiles(f)
        setPreviews(
          f
            .filter((x) => x.type.startsWith('image/'))
            .map((x) => URL.createObjectURL(x)),
        )
        setLoading(false)
      })
    } else {
      setLoading(false)
    }
  }, [])

  // Clean up object URLs
  useEffect(
    () => () => previews.forEach((p) => URL.revokeObjectURL(p)),
    [previews],
  )

  async function pick(convId: string | null) {
    if (sending) return
    setSending(true)
    try {
      let targetId = convId
      if (!targetId) {
        const conv = await api.createConversation()
        targetId = conv.id
      }
      onReady(targetId, message, files.length > 0 ? files : undefined)
    } catch {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <div className='flex items-center justify-center h-full'>
        <div className='animate-pulse-soft text-text-muted text-sm'>
          Loading shared content...
        </div>
      </div>
    )
  }

  const hasContent = message.trim() || files.length > 0
  if (!hasContent) {
    return (
      <div className='flex items-center justify-center h-full'>
        <p className='text-text-muted text-sm'>Nothing to share.</p>
      </div>
    )
  }

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='flex items-center justify-between px-4 pt-4 pb-2'>
        <h2 className='text-base font-medium text-text-primary'>Share to...</h2>
        <button
          onClick={() => navigate('/', { replace: true })}
          className='p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'
          title='Cancel'
        >
          <X size={18} />
        </button>
      </div>

      {/* Shared content preview */}
      <div className='border-b border-border px-4 pb-4'>
        {/* File previews */}
        {files.length > 0 && (
          <div className='flex flex-wrap gap-2 mb-2'>
            {files.map((f, i) => {
              const isImage = f.type.startsWith('image/')
              return isImage && previews[i] ? (
                <img
                  key={i}
                  src={previews[i]}
                  alt={f.name}
                  className='w-14 h-14 rounded-lg object-cover border border-border'
                />
              ) : (
                <div
                  key={i}
                  className='flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-surface text-xs text-text-secondary'
                >
                  <FileText size={14} className='shrink-0' />
                  <span className='truncate max-w-[120px]'>{f.name}</span>
                </div>
              )
            })}
          </div>
        )}
        {/* Text preview */}
        {message.trim() && (
          <p className='text-sm text-text-primary line-clamp-3 whitespace-pre-wrap'>
            {message}
          </p>
        )}
      </div>

      {/* Conversation picker */}
      <div className='flex-1 overflow-y-auto'>
        {/* New conversation */}
        <button
          onClick={() => pick(null)}
          disabled={sending}
          className='w-full flex items-center gap-3 px-4 py-3 hover:bg-surface transition-colors border-b border-border disabled:opacity-50'
        >
          <div className='w-9 h-9 rounded-full bg-accent flex items-center justify-center shrink-0'>
            <Plus size={18} className='text-white' />
          </div>
          <span className='text-sm font-medium text-text-primary'>
            New conversation
          </span>
        </button>

        {/* Existing conversations */}
        {conversations.length > 0 && (
          <div className='px-4 pt-3 pb-1'>
            <h3 className='text-xs font-medium text-text-muted uppercase tracking-wider'>
              Recent
            </h3>
          </div>
        )}
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => pick(conv.id)}
            disabled={sending}
            className='w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface transition-colors disabled:opacity-50'
          >
            <div className='w-9 h-9 rounded-full bg-surface2 flex items-center justify-center shrink-0'>
              <MessageSquare size={16} className='text-text-muted' />
            </div>
            <div className='flex-1 text-left min-w-0'>
              <span className='text-sm text-text-primary block truncate'>
                {conv.title}
              </span>
              <span className='text-xs text-text-muted'>
                {new Date(conv.updated_at * 1000).toLocaleDateString()}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
