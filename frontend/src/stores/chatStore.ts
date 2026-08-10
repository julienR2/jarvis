import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  api,
  type Conversation,
  type ConversationWithMessages,
  type Message,
  type Section,
} from '../api'

type PatchableFields = Pick<
  Conversation,
  'title' | 'notify' | 'model' | 'effort' | 'section_id'
>

// How many messages to pull per page. Deliberately generous: one round-trip
// covers most conversations entirely, and paging is only there to keep very
// long ones (mail triage, crons) from rendering thousands of bubbles at once.
export const MESSAGE_PAGE_SIZE = 100

interface ChatState {
  conversations: Record<string, Conversation>
  order: string[]
  sections: Section[]
  messages: Record<string, Message[]>
  /** Older messages exist before `messages[convId][0]`. */
  hasMore: Record<string, boolean>
  loadingOlder: Record<string, boolean>
  processing: Record<string, boolean>
  listLoaded: boolean
  convsLoaded: Record<string, boolean>

  // ── List actions ─────────────────────────────────────────────────────────
  loadConversations: () => Promise<void>
  createConversation: (title?: string) => Promise<Conversation>
  deleteConversation: (id: string) => Promise<void>

  // ── Section actions ──────────────────────────────────────────────────────
  loadSections: () => Promise<void>
  createSection: (name: string) => Promise<Section | null>
  renameSection: (id: string, name: string) => Promise<void>
  deleteSection: (id: string) => Promise<void>
  moveSection: (id: string, delta: -1 | 1) => Promise<void>

  // ── Single-conversation actions ──────────────────────────────────────────
  loadConversation: (id: string) => Promise<void>
  loadOlderMessages: (id: string) => Promise<void>
  resyncConversation: (id: string) => Promise<void>
  patchConversation: (id: string, patch: Partial<PatchableFields>) => Promise<void>

  // ── SSE-driven mutations (no API call) ───────────────────────────────────
  upsertMessage: (convId: string, msg: Message) => void
  setProcessing: (convId: string, value: boolean) => void
  setTitleFromEvent: (convId: string, title: string) => void
  setContextUsage: (convId: string, tokens: number, windowTokens: number | null) => void
  incrementUnread: (convId: string) => void
  markRead: (convId: string) => void
  reconcileConversation: (full: ConversationWithMessages) => void
}

function toast(kind: 'error' | 'info', msg: string) {
  window.__jarvisToast?.[kind](msg)
}

// Any refetch of a conversation must ask for at least as many messages as are
// already on screen, otherwise re-syncing (SSE reconnect, app refresh) would
// throw away the older pages the user scrolled back through.
function loadedWindow(state: ChatState, id: string): number {
  return Math.max(MESSAGE_PAGE_SIZE, state.messages[id]?.length ?? 0)
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
    sections: [],
    messages: {},
    hasMore: {},
    loadingOlder: {},
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
        delete s.hasMore[id]
        delete s.loadingOlder[id]
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

    async loadSections() {
      try {
        const sections = await api.getSections()
        set((s) => {
          s.sections = sections
        })
      } catch (err) {
        console.error('Failed to load sections:', err)
      }
    },

    async createSection(name) {
      try {
        const section = await api.createSection(name)
        set((s) => {
          s.sections.push(section)
        })
        return section
      } catch (err) {
        console.error('Failed to create section:', err)
        toast('error', 'Failed to create section')
        return null
      }
    },

    async renameSection(id, name) {
      const before = get().sections
      set((s) => {
        const target = s.sections.find((x) => x.id === id)
        if (target) target.name = name
      })
      try {
        await api.renameSection(id, name)
      } catch (err) {
        console.error('Failed to rename section:', err)
        toast('error', 'Failed to rename section')
        set((s) => {
          s.sections = before
        })
      }
    },

    async deleteSection(id) {
      const before = { sections: get().sections, conversations: get().conversations }
      // The server drops the section's conversations back into the default group
      // (ON DELETE SET NULL) — mirror that locally so the sidebar doesn't blink.
      set((s) => {
        s.sections = s.sections.filter((x) => x.id !== id)
        for (const conv of Object.values(s.conversations)) {
          if (conv.section_id === id) conv.section_id = null
        }
      })
      try {
        await api.deleteSection(id)
      } catch (err) {
        console.error('Failed to delete section:', err)
        toast('error', 'Failed to delete section')
        set((s) => {
          s.sections = before.sections
          s.conversations = before.conversations
        })
      }
    },

    async moveSection(id, delta) {
      const before = get().sections
      const idx = before.findIndex((x) => x.id === id)
      const target = idx + delta
      if (idx < 0 || target < 0 || target >= before.length) return

      const reordered = before.slice()
      ;[reordered[idx], reordered[target]] = [reordered[target], reordered[idx]]
      set((s) => {
        s.sections = reordered
      })
      try {
        const saved = await api.reorderSections(reordered.map((x) => x.id))
        set((s) => {
          s.sections = saved
        })
      } catch (err) {
        console.error('Failed to reorder sections:', err)
        toast('error', 'Failed to reorder sections')
        set((s) => {
          s.sections = before
        })
      }
    },

    async loadConversation(id) {
      try {
        const conv = await api.getConversation(id, loadedWindow(get(), id))
        set((s) => {
          const { messages, has_more, ...meta } = conv
          s.conversations[id] = meta
          if (!s.order.includes(id)) s.order.unshift(id)
          s.messages[id] = mergeMessages(s.messages[id] ?? [], messages)
          s.hasMore[id] = has_more
          s.convsLoaded[id] = true
        })
      } catch (err) {
        console.error('Failed to load conversation:', err)
      }
    },

    async loadOlderMessages(id) {
      const state = get()
      if (state.loadingOlder[id] || !state.hasMore[id]) return
      const oldest = state.messages[id]?.[0]
      if (!oldest?.seq) return

      set((s) => {
        s.loadingOlder[id] = true
      })
      try {
        const page = await api.getOlderMessages(id, oldest.seq, MESSAGE_PAGE_SIZE)
        set((s) => {
          const list = s.messages[id] ?? []
          const known = new Set(list.map((m) => m.id))
          const older = page.messages.filter((m) => !known.has(m.id))
          s.messages[id] = [...older, ...list]
          // If a page brought nothing new the cursor can't advance, so stop
          // rather than let the scroll sentinel refetch it forever.
          s.hasMore[id] = page.has_more && older.length > 0
        })
      } catch (err) {
        console.error('Failed to load older messages:', err)
        toast('error', 'Failed to load older messages')
      } finally {
        set((s) => {
          s.loadingOlder[id] = false
        })
      }
    },

    async resyncConversation(id) {
      try {
        const full = await api.getConversation(id, loadedWindow(get(), id))
        get().reconcileConversation(full)
      } catch (err) {
        console.error('Failed to resync conversation:', err)
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
        if (patch.effort !== undefined) apiPatch.effort = patch.effort
        if (patch.section_id !== undefined) apiPatch.section_id = patch.section_id
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

    setContextUsage(convId, tokens, windowTokens) {
      set((s) => {
        const c = s.conversations[convId]
        if (!c) return
        c.context_tokens = tokens
        // null means the engine doesn't recognise the model in use. Hide the
        // gauge rather than keep the previous model's window — mirrors what the
        // backend persists, so a reload shows the same thing.
        c.context_window = windowTokens
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
        const { messages, has_more, ...meta } = full
        s.conversations[full.id] = meta
        if (!s.order.includes(full.id)) s.order.unshift(full.id)
        s.messages[full.id] = mergeMessages(s.messages[full.id] ?? [], messages)
        s.hasMore[full.id] = has_more
        s.convsLoaded[full.id] = true
        s.processing[full.id] = false
      })
    },
  })),
)
