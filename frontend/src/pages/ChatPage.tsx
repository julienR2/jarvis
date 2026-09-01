import { useState, useEffect, useRef } from 'react'
import {
  Routes,
  Route,
  useNavigate,
  useLocation,
  useSearchParams,
} from 'react-router-dom'
import { Plus, MessageSquare, FileText, X, AppWindow, Clock, Link2, Sparkles, AudioLines, Mic } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import Sidebar from '../components/Sidebar'
import ChatView from '../components/ChatView'
import CronManager from '../components/CronManager'
import WebhookManager from '../components/WebhookManager'
import CodeBrowser from '../components/CodeBrowser'
import ConnectorsPage from '../components/ConnectorsPage'
import ConnectionPage from '../components/ConnectionPage'
import UpdateBanner from '../components/UpdateBanner'
import PluginsPage from '../components/PluginsPage'
import {
  SidebarToggleProvider,
  SidebarToggle,
} from '../components/ContentLayout'
import { api, type Conversation, type Attachment } from '../api'
import { useChatStore } from '../stores/chatStore'
import { useServiceWorker } from '../hooks/useServiceWorker'
import { useGlobalEvents } from '../hooks/useGlobalEvents'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { useSwipeToOpen } from '../hooks/useSwipeToOpen'

export default function ChatPage() {
  const listLoaded = useChatStore((s) => s.listLoaded)
  const hasUnread = useChatStore((s) =>
    s.order.some((id) => (s.conversations[id]?.unread_count ?? 0) > 0),
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
    { key: 'n', meta: true, shift: true, action: newConversation, description: 'New chat' },
  ])

  useEffect(() => {
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

  async function newConversation() {
    const conv = await useChatStore.getState().createConversation()
    navigate(`/c/${conv.id}`)
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
          onDelete={async (id) => {
            const onCurrent = locationRef.current === `/c/${id}`
            await useChatStore.getState().deleteConversation(id)
            if (onCurrent) navigate('/', { replace: true })
          }}
          onRename={(id, title) => useChatStore.getState().patchConversation(id, { title })}
          onMove={(id, sectionId) =>
            useChatStore.getState().patchConversation(id, { section_id: sectionId })
          }
          onSelect={() => setSidebarOpen(false)}
        />
      </div>

      <main className='flex-1 overflow-hidden flex flex-col'>
        <SidebarToggleProvider value={{ onToggle: () => setSidebarOpen(true), hasUnread }}>
          <Routes>
            <Route
              path='/'
              element={
                listLoaded ? (
                  <Welcome onNew={newConversation} />
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
            <Route path='/crons' element={<CronManager />} />
            <Route path='/webhooks' element={<WebhookManager />} />
            <Route path='/connectors' element={<ConnectorsPage />} />
            <Route path='/connection' element={<ConnectionPage />} />
            <Route path='/plugins' element={<PluginsPage />} />
            <Route path='/code/*' element={<CodeBrowser />} />
          </Routes>
        </SidebarToggleProvider>
      </main>

      <UpdateBanner />
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

/** Home's section folds are per-device, and separate from the sidebar's. */
const HOME_COLLAPSE_KEY = 'home-sections-collapsed'

function readHomeCollapsed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HOME_COLLAPSE_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function Welcome({ onNew }: { onNew: () => void }) {
  const navigate = useNavigate()
  // Home surfaces the chats you filed into sections, in section order. The
  // catch-all "Chats" group is left to the sidebar.
  const sections = useChatStore(useShallow((s) => s.sections))
  const conversations = useChatStore(
    useShallow((s) => s.order.map((id) => s.conversations[id]).filter(Boolean)),
  )
  const filed = sections
    .map((section) => ({
      section,
      convs: conversations.filter((c) => c.section_id === section.id),
    }))
    .filter((g) => g.convs.length > 0)

  // Kept out of the sidebar's key: folding a section on home shouldn't fold it
  // in the sidebar too, they're browsed differently.
  const [collapsed, setCollapsed] = useState<string[]>(readHomeCollapsed)
  useEffect(() => {
    localStorage.setItem(HOME_COLLAPSE_KEY, JSON.stringify(collapsed))
  }, [collapsed])
  const toggle = (id: string) =>
    setCollapsed((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )

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
        <div className='flex items-center gap-3'>
          <button
            onClick={onNew}
            className='flex items-center gap-2 bg-accent text-white px-5 py-2.5 rounded-xl font-medium hover:bg-accent-hover transition-colors'
          >
            <Plus size={18} />
            New conversation
          </button>
          <button
            onClick={() => navigate('/onboarding')}
            className='flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium border border-border text-text-secondary hover:bg-surface hover:text-text-primary transition-colors'
          >
            <Sparkles size={16} />
            Setup wizard
          </button>
        </div>
      </div>

      {/* One grid per section */}
      {filed.map(({ section, convs }) => {
        const isCollapsed = collapsed.includes(section.id)
        const unread = convs.reduce((n, c) => n + (c.unread_count || 0), 0)
        return (
        <div key={section.id} className='max-w-2xl w-full mx-auto px-4 pb-8 mt-2'>
          <button
            onClick={() => toggle(section.id)}
            className='flex items-center gap-1.5 mb-3 text-xs font-medium text-text-muted uppercase tracking-wider hover:text-text-secondary transition-colors'
          >
            {section.name}
            {isCollapsed && unread > 0 && (
              <span className='min-w-[18px] h-[18px] px-1.5 flex items-center justify-center rounded-full bg-accent text-white text-[10px] font-medium'>
                {unread}
              </span>
            )}
          </button>
          <div
            className={`grid grid-cols-2 md:grid-cols-3 gap-3 ${isCollapsed ? 'hidden' : ''}`}
          >
            {convs.map((conv) => (
              <button
                key={conv.id}
                onClick={() => navigate(`/c/${conv.id}`)}
                className='flex flex-col gap-2 px-4 py-3 rounded-xl bg-surface border border-border hover:border-accent/40 hover:bg-surface2 transition-colors text-left'
              >
                <span className='flex items-center justify-between gap-1.5'>
                  <span className='flex items-center gap-1.5 text-text-muted'>
                    {!!conv.app_path && <AppWindow size={13} />}
                    {!!conv.has_cron && <Clock size={13} />}
                    {!!conv.has_webhook && <Link2 size={13} />}
                  </span>
                  {conv.unread_count > 0 && (
                    <span className='min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-accent text-white text-[11px] font-medium'>
                      {conv.unread_count}
                    </span>
                  )}
                </span>
                <span className='text-sm text-text-primary truncate'>
                  {conv.title}
                </span>
              </button>
            ))}
          </div>
        </div>
        )
      })}
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

// Pre-prompts fired when the user picks a transcription engine for shared audio.
// Each one is written to trigger the matching skill on the attached file. Edit freely.
const TRANSCRIBE_PROMPTS = {
  elevenlabs:
    'Please transcribe the attached audio file using ElevenLabs (the elevenlabs skill), then return the full transcript.',
  whisper:
    'Please transcribe the attached audio file using the local Whisper service (the whisper skill), not ElevenLabs, then return the full transcript.',
}

// Extensions treated as audio when the browser doesn't report an audio/* MIME type
// (some share sources hand over files with an empty or generic type).
const AUDIO_EXTENSIONS = [
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga',
  '.opus', '.flac', '.amr', '.3gp', '.caf', '.wma', '.aiff', '.aif',
]

function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true
  const name = file.name.toLowerCase()
  return AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext))
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
  onReady,
  onAppPick,
  onAutoSent,
}: {
  onReady: (convId: string, message: string, files?: File[]) => void
  onAppPick: (convId: string, intent: { title?: string; text?: string; url?: string; files?: File[] }) => void
  onAutoSent: (convId: string) => void
}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const conversations = useChatStore(
    useShallow((s) => s.order.map((id) => s.conversations[id]).filter(Boolean) as Conversation[]),
  )
  const apps = conversations.filter(c => c.app_path)
  const regularConvs = conversations.filter(c => !c.app_path)
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

  // Transcription quick-action: create a conversation, attach the shared audio,
  // and fire the chosen engine's pre-prompt. Falls back to the picker on failure.
  async function transcribeWith(prompt: string) {
    if (sending) return
    setSending(true)
    try {
      // Conversation first, so the shared audio lands in uploads/<conv id>/ and
      // gets cleaned up with the conversation rather than orphaned at the root.
      const conv = await api.createConversation()
      const attachments: Attachment[] = []
      for (const f of files) {
        attachments.push(await api.uploadFile(f, conv.id))
      }
      await api.sendMessage(conv.id, prompt, attachments)
      onAutoSent(conv.id)
    } catch (err) {
      console.error('Transcription send failed:', err)
      window.__jarvisToast?.error("Couldn't start transcription — try again or pick a conversation.")
      setSending(false)
    }
  }

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

  function pickApp(convId: string) {
    if (sending) return
    setSending(true)
    onAppPick(convId, {
      title: searchParams.get('title') || undefined,
      text: searchParams.get('text') || undefined,
      url: searchParams.get('url') || undefined,
      files: files.length > 0 ? files : undefined,
    })
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
  const hasAudio = files.some(isAudioFile)
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
        {/* Transcribe audio — quick actions shown only when an audio file is shared */}
        {hasAudio && (
          <>
            <div className='px-4 pt-3 pb-1'>
              <h3 className='text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5'>
                <AudioLines size={13} />
                Transcribe audio
              </h3>
            </div>
            <button
              onClick={() => transcribeWith(TRANSCRIBE_PROMPTS.elevenlabs)}
              disabled={sending}
              className='w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface transition-colors disabled:opacity-50'
            >
              <div className='w-9 h-9 rounded-full bg-violet-500/10 flex items-center justify-center shrink-0'>
                <Mic size={16} className='text-violet-600 dark:text-violet-400' />
              </div>
              <div className='flex-1 text-left min-w-0'>
                <span className='text-sm text-text-primary block truncate'>
                  Transcribe with ElevenLabs
                </span>
                <span className='text-xs text-text-muted'>High-quality · multilingual</span>
              </div>
            </button>
            <button
              onClick={() => transcribeWith(TRANSCRIBE_PROMPTS.whisper)}
              disabled={sending}
              className='w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface transition-colors border-b border-border disabled:opacity-50'
            >
              <div className='w-9 h-9 rounded-full bg-sky-500/10 flex items-center justify-center shrink-0'>
                <Mic size={16} className='text-sky-600 dark:text-sky-400' />
              </div>
              <div className='flex-1 text-left min-w-0'>
                <span className='text-sm text-text-primary block truncate'>
                  Transcribe with Whisper
                </span>
                <span className='text-xs text-text-muted'>Local · private</span>
              </div>
            </button>
          </>
        )}

        {/* Apps */}
        {apps.length > 0 && (
          <>
            <div className='px-4 pt-3 pb-1'>
              <h3 className='text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5'>
                <AppWindow size={13} />
                Apps
              </h3>
            </div>
            {apps.map((conv) => (
              <button
                key={conv.id}
                onClick={() => pickApp(conv.id)}
                disabled={sending}
                className='w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface transition-colors disabled:opacity-50'
              >
                <div className='w-9 h-9 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0'>
                  <AppWindow size={16} className='text-emerald-600 dark:text-emerald-400' />
                </div>
                <div className='flex-1 text-left min-w-0'>
                  <span className='text-sm text-text-primary block truncate'>
                    {conv.title}
                  </span>
                </div>
              </button>
            ))}
          </>
        )}

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
        {regularConvs.length > 0 && (
          <div className='px-4 pt-3 pb-1'>
            <h3 className='text-xs font-medium text-text-muted uppercase tracking-wider'>
              Recent
            </h3>
          </div>
        )}
        {regularConvs.map((conv) => (
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
