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
    const currentConvId = () => pathRef.current.match(/^\/c\/(.+)$/)?.[1]

    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      const store = useChatStore.getState()
      store.loadConversations().then(() => {
        // Back in front: whatever arrived in the conversation that's on screen
        // has now genuinely been seen, so drop its badge. The server-side mark
        // catches up on the next stream close.
        const id = currentConvId()
        if (id) store.markRead(id)
      })
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    const conn = connectGlobalEvents((ev) => {
      if (ev.type === 'new_message') {
        // "Viewing" is route *and* foreground. Route alone was wrong: leaving
        // the app mid-answer keeps the route pointed at the conversation, so
        // the reply was counted as already read and never raised a badge.
        if (
          ev.conversation_id === currentConvId() &&
          document.visibilityState === 'visible'
        ) {
          return
        }

        const s = useChatStore.getState()
        if (s.conversations[ev.conversation_id]) {
          s.incrementUnread(ev.conversation_id)
          // A reply is activity: it moves the chat to the top of its group, the
          // way the server already orders the list on the next reload.
          s.touchConversation(ev.conversation_id)
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
