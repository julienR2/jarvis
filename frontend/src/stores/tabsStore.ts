import { create } from 'zustand'
import { api, type ChatTab } from '../api'

/**
 * The tabs beside each chat (documents and links), and the signals the side
 * pane reacts to: which tab Jarvis asked to show, and which documents changed
 * on disk. Fed by the chat's event stream (useChatEvents) — the list arrives
 * whole on every change, so there is nothing to merge.
 */
interface TabsState {
  byConv: Record<string, ChatTab[]>
  /** A tab to bring forward, with a nonce so asking twice for the same one still counts. */
  focus: Record<string, { tabId: string; nonce: number }>
  /** Bumped per tab when its file changes, so the document re-reads. */
  versions: Record<string, number>
  setTabs: (conversationId: string, tabs: ChatTab[], focus?: string) => void
  bump: (tabId: string) => void
  load: (conversationId: string) => Promise<void>
}

// Per chat, bumped by every list that lands. A load answers for the moment it
// was asked: if a newer list (an event, a click) landed while it was in
// flight, its answer is older than what is shown, and is dropped.
const generation: Record<string, number> = {}

export const useTabsStore = create<TabsState>()((set) => ({
  byConv: {},
  focus: {},
  versions: {},
  setTabs: (conversationId, tabs, focus) => {
    generation[conversationId] = (generation[conversationId] ?? 0) + 1
    set((s) => ({
      byConv: { ...s.byConv, [conversationId]: tabs },
      focus: focus ? { ...s.focus, [conversationId]: { tabId: focus, nonce: Date.now() } } : s.focus,
    }))
  },
  bump: (tabId) => set((s) => ({ versions: { ...s.versions, [tabId]: (s.versions[tabId] ?? 0) + 1 } })),
  load: async (conversationId) => {
    const asked = generation[conversationId] ?? 0
    try {
      const { tabs } = await api.getTabs(conversationId)
      if ((generation[conversationId] ?? 0) !== asked) return
      generation[conversationId] = asked + 1
      set((s) => ({ byConv: { ...s.byConv, [conversationId]: tabs } }))
    } catch {
      /* no tabs shown is the right failure: the chat itself is unaffected */
    }
  },
}))

const NO_TABS: ChatTab[] = []
export const useChatTabs = (conversationId: string | undefined) =>
  useTabsStore((s) => (conversationId ? s.byConv[conversationId] ?? NO_TABS : NO_TABS))
