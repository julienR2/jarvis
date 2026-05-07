import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { connectGlobalEvents } from '../api'
import { useChatStore } from '../stores/chatStore'

// Subscribes to the global SSE stream and dispatches into the chat store.
// Mounted once near the app root.
export function useGlobalEvents() {
  const location = useLocation()
  const pathRef = useRef(location.pathname)
  useEffect(() => {
    pathRef.current = location.pathname
  }, [location.pathname])

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        useChatStore.getState().loadConversations()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    const conn = connectGlobalEvents((ev) => {
      if (ev.type === 'new_message') {
        const currentMatch = pathRef.current.match(/^\/c\/(.+)$/)
        const currentId = currentMatch?.[1]
        if (ev.conversation_id === currentId) return // user is viewing this conversation

        const s = useChatStore.getState()
        if (s.conversations[ev.conversation_id]) {
          s.incrementUnread(ev.conversation_id)
        } else {
          // New conversation (e.g. from cron) — refresh the full list
          s.loadConversations()
        }
      }
    })

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      conn.close()
    }
  }, [])
}
