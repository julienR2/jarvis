import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { FileText, X } from 'lucide-react'
import { api, type Attachment } from '../api'
import { PinnedTargets, ShareTree, useShareCatalogue, type ShareDestination } from './ShareTargets'

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

type ShareIntent = { title?: string; text?: string; url?: string; files?: File[] }

/**
 * /share — where the PWA share target lands. Pinned destinations first (set in
 * Settings › General), then the sidebar's tree. A chat gets the content in its
 * composer, an app gets it as an intent, a webhook runs on it straight away.
 */
export default function ShareHandler({
  onReady,
  onAppPick,
  onAutoSent,
}: {
  onReady: (convId: string, message: string, files?: File[]) => void
  onAppPick: (convId: string, intent: ShareIntent) => void
  /** The content was already sent (a webhook ran on it): just open where it went. */
  onAutoSent: (convId: string) => void
}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const catalogue = useShareCatalogue()
  const [message, setMessage] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const initialized = useRef(false)

  const intent = {
    title: searchParams.get('title') || undefined,
    text: searchParams.get('text') || undefined,
    url: searchParams.get('url') || undefined,
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const hasFiles = parseInt(searchParams.get('hasFiles') || '0', 10)

    const parts = [intent.title, intent.text, intent.url].filter(Boolean)
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

  async function share(dest: ShareDestination) {
    if (sending) return
    setSending(true)
    try {
      switch (dest.kind) {
        case 'new':
        case 'section': {
          const conv = await api.createConversation(undefined, dest.kind === 'section' ? dest.section.id : null)
          onReady(conv.id, message, files.length > 0 ? files : undefined)
          return
        }
        case 'conversation':
          if (dest.conv.app_path) {
            onAppPick(dest.conv.id, { ...intent, files: files.length > 0 ? files : undefined })
          } else {
            onReady(dest.conv.id, message, files.length > 0 ? files : undefined)
          }
          return
        case 'webhook': {
          // Uploaded into the routine's thread, so the files go with it.
          const { thread_id } = await api.webhookThread(dest.webhook.id)
          const attachments: Attachment[] = []
          for (const f of files) attachments.push(await api.uploadFile(f, thread_id))
          await api.shareToWebhook(dest.webhook.id, { ...intent, attachments })
          onAutoSent(thread_id)
          return
        }
      }
    } catch (err) {
      console.error('Share failed:', err)
      window.__jarvisToast?.error("Couldn't share there — try again or pick another.")
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

      {/* Destinations */}
      <div className='flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-2'>
        {!catalogue.loaded ? (
          <div className='px-2 py-3 animate-pulse-soft text-text-muted text-sm'>Loading...</div>
        ) : (
          <>
            <PinnedTargets catalogue={catalogue} onPick={share} disabled={sending} />
            <ShareTree catalogue={catalogue} onPick={share} disabled={sending} />
          </>
        )}
      </div>
    </div>
  )
}
