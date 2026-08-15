import { useEffect, useRef, useState } from 'react'
import { connectEvents, type ChatEvent } from '../api'
import { useChatStore } from '../stores/chatStore'

// Subscribes to the per-conversation SSE stream and dispatches into the chat store.
// Returns a key that bumps when the backend reports an app refresh, so callers
// can pass it to AppPreview's `refreshKey` to force the iframe to reload.
export function useChatEvents(conversationId: string | undefined): {
  appRefreshKey: number
  bumpApp: () => void
} {
  const [appRefreshKey, setAppRefreshKey] = useState(0)
  const bumpApp = () => setAppRefreshKey((k) => k + 1)

  const convIdRef = useRef(conversationId)
  useEffect(() => {
    convIdRef.current = conversationId
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) return
    const store = useChatStore.getState()
    store.setProcessing(conversationId, false)
    store.clearLive(conversationId)
    store.loadConversation(conversationId)

    const handleEvent = (ev: ChatEvent) => {
      const cid = convIdRef.current
      if (!cid) return
      const s = useChatStore.getState()
      switch (ev.type) {
        case 'message':
          // The authoritative row supersedes whatever was streaming into the
          // live buffer, so drop it here rather than letting both render.
          if (ev.message.role === 'assistant') s.clearLive(cid)
          s.upsertMessage(cid, ev.message)
          break
        case 'delta':
          s.appendDelta(cid, ev.text)
          break
        case 'conversation':
          if (ev.title) s.setTitleFromEvent(cid, ev.title)
          break
        case 'thinking':
          s.setProcessing(cid, ev.thinking)
          break
        case 'usage':
          s.setContextUsage(cid, ev.contextTokens, ev.contextWindow)
          break
        case 'app_updated':
          s.loadConversation(cid)
          setAppRefreshKey((k) => k + 1)
          break
      }
    }

    let wasConnected = false
    const conn = connectEvents(conversationId, handleEvent, (status) => {
      if (status && wasConnected) {
        useChatStore.getState().resyncConversation(conversationId)
      }
      wasConnected = true
    })

    return () => conn.close()
  }, [conversationId])

  return { appRefreshKey, bumpApp }
}
