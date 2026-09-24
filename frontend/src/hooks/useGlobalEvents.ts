import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { connectGlobalEvents } from '../api'
import { useChatStore } from '../stores/chatStore'
import { FRONTEND_UPDATED_EVENT } from '../components/UpdateBanner'
import { RUNS_NUDGE_EVENT } from '../lib/runs'
import { closeNotificationsFor, closeNotificationsOfRead } from '../lib/notifications'

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
        // And this device's notifications for chats read meanwhile (here or
        // elsewhere) come down — the only cross-device dismissal there is.
        closeNotificationsOfRead(useChatStore.getState().conversations)
      })
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    const conn = connectGlobalEvents((ev) => {
      if (ev.type === 'frontend_updated') {
        // The tab is now running a stale bundle. UpdateBanner offers the reload
        // rather than forcing it — a reload mid-reply would be hostile.
        window.dispatchEvent(new CustomEvent(FRONTEND_UPDATED_EVENT))
        return
      }
      if (ev.type === 'runs') {
        window.dispatchEvent(new CustomEvent(RUNS_NUDGE_EVENT))
        return
      }
      if (ev.type === 'conversations_removed') {
        // Empty chats the backend swept. Dropped locally, like a delete.
        useChatStore.getState().forgetConversations(ev.ids)
        return
      }
      if (ev.type === 'sections') {
        // A topic's brief was rewritten (by Jarvis, or from another tab): the
        // topic page and the sidebar read the list, so refetch it.
        useChatStore.getState().loadSections()
        return
      }
      if (ev.type === 'question') {
        // Today's card and the sidebar read the question off the loaded list;
        // patch it in place. A conversation not loaded yet is a new one — the
        // full reload brings it in with the question already on it.
        const s = useChatStore.getState()
        if (s.conversations[ev.conversation_id]) s.setPendingQuestion(ev.conversation_id, ev.question)
        else s.loadConversations()
        return
      }
      if (ev.type === 'new_message') {
        // "Viewing" is route *and* foreground. Route alone was wrong: leaving
        // the app mid-answer keeps the route pointed at the conversation, so
        // the reply was counted as already read and never raised a badge.
        if (
          ev.conversation_id === currentConvId() &&
          document.visibilityState === 'visible'
        ) {
          // Seen as it arrived; the notification the worker showed for it is
          // redundant on this device.
          closeNotificationsFor(ev.conversation_id)
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
