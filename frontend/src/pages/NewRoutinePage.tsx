import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { api, type Conversation } from '../api'
import { useChatStore } from '../stores/chatStore'

/**
 * `/routines/new` — not a form: a new routine is a thread where Jarvis asks
 * what it should be. This opens one and steps into it.
 *
 * `?conversation_id=` attaches it to the chat it was started from, `?kind=`
 * says it should be a webhook.
 */
// One thread per visit to the page — keyed by the navigation, at module level:
// a remount (StrictMode does one on purpose) must not open a second thread.
const opening = new Map<string, Promise<Conversation>>()

export default function NewRoutinePage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { key } = useLocation()
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const kind = params.get('kind') === 'webhook' ? 'webhook' : undefined
    if (!opening.has(key)) opening.set(key, api.startRoutineSetup({ conversationId: params.get('conversation_id'), kind }))
    opening.get(key)!
      .then(async (thread) => {
        if (!alive) return
        await useChatStore.getState().loadConversations()
        navigate(`/c/${thread.id}`, { replace: true })
      })
      .catch((err) => alive && setError(err.message ?? 'Could not start'))
    return () => { alive = false }
  }, [key, params, navigate])

  return (
    <div className='flex h-full items-center justify-center text-sm text-text-muted' data-testid='new-routine'>
      {error ? <span className='text-danger'>{error}</span> : <span className='inline-flex items-center gap-2'><Loader2 size={14} className='animate-spin' /> Opening a new routine…</span>}
    </div>
  )
}
