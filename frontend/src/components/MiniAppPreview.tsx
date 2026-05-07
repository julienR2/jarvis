import { ExternalLink, RefreshCw } from 'lucide-react'

interface Props {
  conversationId: string
  refreshKey: number
  onRefresh: () => void
}

export default function MiniAppPreview({
  conversationId,
  refreshKey,
  onRefresh,
}: Props) {
  const token = localStorage.getItem('token') || ''
  const src = `/api/mini-apps/${conversationId}/index.html?token=${token}&v=${refreshKey}`

  return (
    <div className='flex flex-col h-full bg-white'>
      {/* Toolbar */}
      <div className='border-b border-border flex w-full'>
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

      {/* Iframe — allow-same-origin needed for auth cookie on sub-resources */}
      <iframe
        key={refreshKey}
        src={src}
        sandbox='allow-scripts allow-same-origin allow-forms allow-modals allow-popups'
        className='flex-1 w-full border-0'
        title='Mini-app preview'
      />
    </div>
  )
}
