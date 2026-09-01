import { useEffect, useRef, useState } from 'react'
import { Loader2, ExternalLink, Info } from 'lucide-react'
import { api } from '../api'
import { ContentTitle } from './ContentLayout'

/**
 * The headful browser, embedded.
 *
 * The point is the handoff: the agent hits a login or a captcha it can't get
 * past, you open this, do the human part in the same live session, and go back
 * to the chat. So this is a full-height view rather than a settings form — and
 * it needs no password of its own, because the backend proxies it behind the
 * session you already have.
 */
export default function BrowserPage() {
  const [status, setStatus] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    api.getBrowserStatus()
      .then(({ enabled }) => setStatus(enabled ? 'ready' : 'unavailable'))
      .catch(() => setStatus('unavailable'))
  }, [])

  return (
    <div className='flex flex-col h-screen'>
      <ContentTitle
        action={
          status === 'ready' ? (
            <a
              href='/api/browser/'
              target='_blank'
              rel='noreferrer'
              title='Open in a new tab'
              className='p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'
            >
              <ExternalLink size={14} />
            </a>
          ) : undefined
        }
      >
        Browser
      </ContentTitle>

      {status === 'checking' && (
        <div className='flex-1 flex items-center justify-center text-text-muted'>
          <Loader2 size={20} className='animate-spin' />
        </div>
      )}

      {status === 'unavailable' && (
        <div className='flex-1 overflow-y-auto'>
          <div className='max-w-2xl mx-auto px-6 py-10'>
            <div className='flex gap-3 rounded-xl border border-border bg-surface p-4'>
              <Info size={18} className='text-accent shrink-0 mt-0.5' />
              <div className='text-sm'>
                <p className='text-text-primary font-medium mb-1'>
                  The browser isn't running
                </p>
                <p className='text-text-muted mb-3'>
                  Jarvis always has a headless browser for reading pages. This is
                  the other one — a real Chromium you can watch and click, for
                  logins and captchas the agent can't do alone. It's optional, so
                  it's off unless you start it:
                </p>
                <pre className='bg-bg border border-border rounded-lg p-3 text-xs overflow-x-auto'>
docker compose --profile browser up -d
                </pre>
                <p className='text-text-muted mt-3'>
                  Then set <code className='bg-bg px-1 rounded'>BROWSER_URL=http://chromium:3000</code>{' '}
                  in <code className='bg-bg px-1 rounded'>.env</code> and bring the
                  backend back up. Its profile persists, so logins you do here
                  survive restarts.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {status === 'ready' && (
        <iframe
          ref={frameRef}
          src='/api/browser/'
          title='Browser'
          className='flex-1 w-full border-0 bg-white'
          // Same-origin so the proxied VNC session keeps its own storage; this
          // is Jarvis's own browser, not model-authored content.
          sandbox='allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads'
          allow='clipboard-read; clipboard-write'
        />
      )}
    </div>
  )
}
