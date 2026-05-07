import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  api,
  type Conversation,
  type ConversationWithMessages,
  type Message,
} from '../api'

type PatchableFields = Pick<
  Conversation,
  'title' | 'notify' | 'model' | 'thinking' | 'pinned'
>

interface ChatState {
  conversations: Record<string, Conversation>
  order: string[]
  messages: Record<string, Message[]>
  processing: Record<string, boolean>
  listLoaded: boolean
  convsLoaded: Record<string, boolean>

  // ── List actions ─────────────────────────────────────────────────────────
  loadConversations: () => Promise<void>
  createConversation: (title?: string) => Promise<Conversation>
  deleteConversation: (id: string) => Promise<void>

  // ── Single-conversation actions ──────────────────────────────────────────
  loadConversation: (id: string) => Promise<void>
  patchConversation: (id: string, patch: Partial<PatchableFields>) => Promise<void>

  // ── SSE-driven mutations (no API call) ───────────────────────────────────
  upsertMessage: (convId: string, msg: Message) => void
  setProcessing: (convId: string, value: boolean) => void
  setTitleFromEvent: (convId: string, title: string) => void
  incrementUnread: (convId: string) => void
  markRead: (convId: string) => void
  reconcileConversation: (full: ConversationWithMessages) => void
}

function toast(kind: 'error' | 'info', msg: string) {
  window.__jarvisToast?.[kind](msg)
}

function mergeMessages(prev: Message[], next: Message[]): Message[] {
  if (prev.length === next.length) {
    const identical = next.every(
      (m, i) =>
        prev[i].id === m.id &&
        prev[i].content === m.content &&
        prev[i].result === m.result,
    )
    if (identical) return prev
  }
  return next
}

export const useChatStore = create<ChatState>()(
  immer((set, get) => ({
    conversations: {},
    order: [],
    messages: {},
    processing: {},
    listLoaded: false,
    convsLoaded: {},

    async loadConversations() {
      try {
        const list = await api.getConversations()
        set((s) => {
          s.conversations = {}
          s.order = []
          for (const c of list) {
            s.conversations[c.id] = c
            s.order.push(c.id)
          }
          s.listLoaded = true
        })
      } catch (err) {
        console.error('Failed to load conversations:', err)
        set((s) => {
          s.listLoaded = true
        })
      }
    },

    async createConversation(title) {
      const conv = await api.createConversation(title)
      set((s) => {
        s.conversations[conv.id] = conv
        s.order.unshift(conv.id)
      })
      return conv
    },

    async deleteConversation(id) {
      const snapshot = {
        conv: get().conversations[id],
        orderIdx: get().order.indexOf(id),
        messages: get().messages[id],
      }
      set((s) => {
        delete s.conversations[id]
        s.order = s.order.filter((x) => x !== id)
        delete s.messages[id]
        delete s.processing[id]
        delete s.convsLoaded[id]
      })
      try {
        await api.deleteConversation(id)
      } catch (err) {
        console.error('Failed to delete conversation:', err)
        toast('error', 'Failed to delete conversation')
        if (snapshot.conv) {
          set((s) => {
            s.conversations[id] = snapshot.conv!
            const idx = snapshot.orderIdx >= 0 ? snapshot.orderIdx : 0
            s.order.splice(idx, 0, id)
            if (snapshot.messages) s.messages[id] = snapshot.messages
          })
        }
        throw err
      }
    },

    async loadConversation(id) {
      try {
        const conv = await api.getConversation(id)
        set((s) => {
          const { messages, ...meta } = conv
          s.conversations[id] = meta
          if (!s.order.includes(id)) s.order.unshift(id)
          s.messages[id] = mergeMessages(s.messages[id] ?? [], messages)
          s.convsLoaded[id] = true
        })
      } catch (err) {
        console.error('Failed to load conversation:', err)
      }
    },

    async patchConversation(id, patch) {
      const before = get().conversations[id]
      if (!before) return
      const optimistic: Conversation = { ...before, ...patch }
      set((s) => {
        s.conversations[id] = optimistic
      })
      try {
        const apiPatch: Parameters<typeof api.updateConversation>[1] = {}
        if (patch.title !== undefined) apiPatch.title = patch.title
        if (patch.notify !== undefined) apiPatch.notify = patch.notify
        if (patch.model !== undefined) apiPatch.model = patch.model ?? undefined
        if (patch.thinking !== undefined) apiPatch.thinking = !!patch.thinking
        if (patch.pinned !== undefined) apiPatch.pinned = !!patch.pinned
        const updated = await api.updateConversation(id, apiPatch)
        set((s) => {
          s.conversations[id] = updated
        })
      } catch (err) {
        console.error('Failed to update conversation:', err)
        toast('error', 'Failed to save changes')
        set((s) => {
          s.conversations[id] = before
        })
        throw err
      }
    },

    upsertMessage(convId, msg) {
      set((s) => {
        const list = s.messages[convId] ?? []
        const idx = list.findIndex((m) => m.id === msg.id)
        if (idx >= 0) list[idx] = msg
        else list.push(msg)
        s.messages[convId] = list
      })
    },

    setProcessing(convId, value) {
      set((s) => {
        s.processing[convId] = value
      })
    },

    setTitleFromEvent(convId, title) {
      set((s) => {
        const c = s.conversations[convId]
        if (c) c.title = title
      })
    },

    incrementUnread(convId) {
      set((s) => {
        const c = s.conversations[convId]
        if (c) c.unread_count += 1
      })
    },

    markRead(convId) {
      set((s) => {
        const c = s.conversations[convId]
        if (c && c.unread_count !== 0) c.unread_count = 0
      })
    },

    reconcileConversation(full) {
      set((s) => {
        const { messages, ...meta } = full
        s.conversations[full.id] = meta
        if (!s.order.includes(full.id)) s.order.unshift(full.id)
        s.messages[full.id] = mergeMessages(s.messages[full.id] ?? [], messages)
        s.convsLoaded[full.id] = true
        s.processing[full.id] = false
      })
    },
  })),
)
