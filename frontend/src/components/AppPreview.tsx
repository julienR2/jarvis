import { useRef, useEffect } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'

interface ShareIntent {
  title?: string
  text?: string
  url?: string
  files?: File[]
}

interface Props {
  appSlug: string
  refreshKey: number
  onRefresh: () => void
  shareIntent?: ShareIntent | null
  onShareIntentConsumed?: () => void
}

async function fileToDataUrl(file: File): Promise<{ name: string; type: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result as string })
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function AppPreview({
  appSlug,
  refreshKey,
  onRefresh,
  shareIntent,
  onShareIntentConsumed,
}: Props) {
  const token = localStorage.getItem('token') || ''
  const appPathRef = useRef(window.location.hash.replace(/^#\/?/, ''))
  const hash = appPathRef.current ? `#${appPathRef.current}` : ''
  const src = `/api/apps/${appSlug}/index.html?token=${token}&v=${refreshKey}${hash}`
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const pendingIntentRef = useRef<ShareIntent | null>(null)

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'app:navigate') {
        const path = e.data.path || ''
        appPathRef.current = path
        window.location.hash = path ? `#${path}` : ''
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (shareIntent) pendingIntentRef.current = shareIntent
  }, [shareIntent])

  async function handleIframeLoad() {
    const intent = pendingIntentRef.current
    if (!intent) return
    pendingIntentRef.current = null

    const files = await Promise.all(
      (intent.files || []).map(fileToDataUrl),
    )

    iframeRef.current?.contentWindow?.postMessage({
      type: 'jarvis:share-intent',
      title: intent.title || '',
      text: intent.text || '',
      url: intent.url || '',
      files,
    }, '*')

    onShareIntentConsumed?.()
  }

  return (
    <div className='flex flex-col h-full bg-white'>
      {/* Toolbar — hidden on mobile where actions are in the header */}
      <div className='border-b border-border hidden md:flex w-full'>
        <div className='flex flex-1 items-center gap-1 px-3 bg-bg h-12 shrink-0'>
          <span className='text-text-muted flex-1 truncate px-1 font-medium'>
            Preview
          </span>
          <button
            onClick={onRefresh}
            title='Refresh preview'
            className='p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'
          >
            <RefreshCw size={13} />
          </button>
          <a
            href={src}
            target='_blank'
            rel='noopener noreferrer'
            title='Open in new tab'
            className='p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'
          >
            <ExternalLink size={13} />
          </a>
        </div>
      </div>

      <iframe
        ref={iframeRef}
        key={refreshKey}
        src={src}
        onLoad={handleIframeLoad}
        allow='microphone'
        sandbox='allow-scripts allow-same-origin allow-forms allow-modals allow-popups'
        className='flex-1 w-full border-0'
        title='App preview'
      />
    </div>
  )
}
