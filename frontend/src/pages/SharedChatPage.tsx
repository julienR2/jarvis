import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import ChatView from '../components/ChatView'
import { resolveShare, useShareCredential } from '../api'
import type { SharedConversationRef } from '../api'

/**
 * A shared conversation.
 *
 * Deliberately thin: it turns the link's token into a credential and a
 * conversation id, then renders the ordinary ChatView. Everything a visitor
 * sees — bubbles, streaming, the app pane, the Chat/Preview toggle — is the
 * same code the owner uses, so the shared view keeps up with chat by
 * construction instead of being a copy that slowly falls behind.
 *
 * What it does not render is the shell: no sidebar (this route is outside it,
 * and the toggle hides itself without its provider) and no conversation
 * actions, which is ChatView's `shared` mode.
 */
export default function SharedChatPage() {
  const { token = '' } = useParams()
  const [ref, setRef] = useState<SharedConversationRef | null>(null)
  const [error, setError] = useState('')

  // Set before the first render that reaches the API, so ChatView's own loads
  // already carry the share credential rather than firing unauthenticated.
  useShareCredential(token)

  useEffect(() => {
    let cancelled = false
    resolveShare(token)
      .then((r) => { if (!cancelled) setRef(r) })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => {
      cancelled = true
      useShareCredential(null)
    }
  }, [token])

  if (error) {
    return (
      <div className='h-screen w-full bg-bg flex items-center justify-center px-6'>
        <p className='text-text-muted text-sm text-center'>{error}</p>
      </div>
    )
  }

  if (!ref) {
    return (
      <div className='h-screen w-full bg-bg flex items-center justify-center text-text-muted'>
        <Loader2 size={20} className='animate-spin' />
      </div>
    )
  }

  return (
    <div className='h-screen w-full bg-bg'>
      <ChatView
        conversationId={ref.id}
        shared={{ readOnly: ref.mode !== 'write' }}
      />
    </div>
  )
}
