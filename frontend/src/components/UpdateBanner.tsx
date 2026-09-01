import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { reloadApp } from '../lib/reload'

// Shown when the backend reports that Jarvis rebuilt its own frontend.
//
// The container serves a production build behind `vite preview`, so there is no
// HMR: until the tab reloads it keeps running the old bundle. The agent saying
// "I've updated the interface" is otherwise indistinguishable from nothing
// happening, which is a confusing first impression of a self-editing assistant.
export const FRONTEND_UPDATED_EVENT = 'jarvis:frontend-updated'

export default function UpdateBanner() {
  const [pending, setPending] = useState(false)
  const [reloading, setReloading] = useState(false)

  useEffect(() => {
    const onUpdate = () => setPending(true)
    window.addEventListener(FRONTEND_UPDATED_EVENT, onUpdate)
    return () => window.removeEventListener(FRONTEND_UPDATED_EVENT, onUpdate)
  }, [])

  if (!pending) return null

  return (
    <div className='fixed bottom-4 left-1/2 -translate-x-1/2 z-[1000] animate-fade-in'>
      <div className='flex items-center gap-3 bg-surface border border-accent/40 rounded-xl shadow-lg pl-4 pr-2 py-2.5'>
        <p className='text-sm text-text-primary'>
          Jarvis updated its interface.
        </p>
        <button
          onClick={() => { setReloading(true); reloadApp() }}
          disabled={reloading}
          className='flex items-center gap-1.5 bg-accent text-white text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-accent-hover disabled:opacity-70 transition-colors'
        >
          <RefreshCw size={14} className={reloading ? 'animate-spin' : undefined} />
          {reloading ? 'Reloading…' : 'Reload'}
        </button>
        <button
          onClick={() => setPending(false)}
          className='text-text-muted hover:text-text-primary p-1'
          aria-label='Dismiss'
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
