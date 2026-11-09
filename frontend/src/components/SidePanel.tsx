import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, ExternalLink, FileText, FolderInput, FolderMinus, FolderOpen, Globe, Hash, LayoutGrid, Maximize2, Pin, RefreshCw, Repeat, X } from 'lucide-react'
import { api, tabContentUrl, type ChatTab } from '../api'
import { useChatStore } from '../stores/chatStore'
import { useTabsStore } from '../stores/tabsStore'
import { Markdown } from './MessageBubble'

/** What the side pane shows: the chat's app, one of its tabs, or a thread (`thread:<id>`, `thread:new`). */
export type PanelKey = 'app' | string

/** A thread open beside the chat. */
export interface ThreadTab {
  key: string
  title: string
  unread: number
  /** A routine's thread rather than one opened from a passage. */
  routine?: boolean
}

interface Props {
  conversationId: string
  tabs: ChatTab[]
  active: PanelKey
  onActivate: (key: PanelKey) => void
  /** The chat's app, already built — kept mounted while another tab is shown, so it keeps its state. */
  app?: { node: ReactNode; onRefresh: () => void; url?: string }
  /** The chat's topic, when it has one: its tabs can be shared with it. */
  topicId?: string | null
  /** Threads open beside the chat, after the documents. */
  threads?: ThreadTab[]
  renderThread?: (key: string) => ReactNode
  onCloseThread?: (key: string) => void
  /** Done: put a thread away. */
  onThreadDone?: (id: string) => void
  /** Shown instead of the chat (a phone): the way back to it, first in the strip. */
  onBack?: () => void
}

/**
 * The pane beside the chat once it holds more than the app: one bar — a strip
 * of tabs (the app first, then documents and links in the order they were
 * opened, then threads) with the selected tab's actions at its end — and the
 * tab selected. The temporary tab (unpinned, replaced by the next one opened)
 * is in italics, as in an editor's preview tab; double-click or the pin keeps
 * it. A thread's tab is its title: double-click renames it.
 */
export default function SidePanel({ conversationId, tabs, active, onActivate, app, topicId, threads = [], renderThread, onCloseThread, onThreadDone, onBack }: Props) {
  const navigate = useNavigate()
  const setTabs = useTabsStore((s) => s.setTabs)
  const bump = useTabsStore((s) => s.bump)
  const activeTab = tabs.find((t) => t.id === active)

  const pin = (tab: ChatTab) =>
    api.updateTab(conversationId, tab.id, { pinned: true }).then(({ tabs }) => setTabs(conversationId, tabs)).catch(() => {})
  const close = (tab: ChatTab) =>
    api.closeTab(conversationId, tab.id).then(({ tabs }) => setTabs(conversationId, tabs)).catch(() => {})
  const shareWithTopic = (tab: ChatTab) =>
    api.shareTabWithTopic(conversationId, tab.id)
      .then(({ tab: shared, tabs }) => { setTabs(conversationId, tabs); onActivate(shared.id) })
      .catch((e: Error) => window.__jarvisToast?.error(e.message))
  // Every chat of the topic gets the new list by event, this one included.
  const removeFromTopic = (tab: ChatTab) =>
    api.removeTopicDoc(tab.topic!.id, tab.id).catch((e: Error) => window.__jarvisToast?.error(e.message))

  const activeThread = threads.find((t) => t.key === active)
  const openUrl = activeThread ? undefined : activeTab ? (activeTab.kind === 'link' ? activeTab.target : tabContentUrl(activeTab)) : app?.url
  const refresh = activeThread ? undefined : activeTab ? () => bump(activeTab.id) : app?.onRefresh
  const threadId = activeThread && activeThread.key !== 'thread:new' ? activeThread.key.slice('thread:'.length) : null
  const renameThread = (key: string, title: string) =>
    key !== 'thread:new' && useChatStore.getState().patchConversation(key.slice('thread:'.length), { title })

  // The strip scrolls sideways once the tabs outgrow it: a vertical wheel
  // scrolls it too, its edges fade where more tabs hide, and the selected one
  // is always brought into view.
  const strip = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState({ left: false, right: false })
  const measure = () => {
    const el = strip.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setHidden((h) => (h.left === left && h.right === right ? h : { left, right }))
  }
  // Scrolls the strip only — scrollIntoView would move the page around it too.
  const reveal = () => {
    const el = strip.current
    const tab = el?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!el || !tab) return
    const start = tab.offsetLeft - el.offsetLeft
    const end = start + tab.offsetWidth
    if (start < el.scrollLeft) el.scrollLeft = start
    else if (end > el.scrollLeft + el.clientWidth) el.scrollLeft = end - el.clientWidth
  }
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const observer = new ResizeObserver(() => { reveal(); measure() })
    observer.observe(el)
    for (const child of Array.from(el.children)) observer.observe(child)
    measure()
    return () => observer.disconnect()
  }, [tabs.length, threads.length, !!app])
  useEffect(() => {
    reveal()
    measure()
  }, [active])
  const fade = `linear-gradient(to right, ${hidden.left ? 'transparent' : '#000'}, #000 ${hidden.left ? '1.5rem' : '0'}, #000 calc(100% - ${hidden.right ? '1.5rem' : '0px'}), ${hidden.right ? 'transparent' : '#000'})`

  return (
    <div className='flex flex-col h-full bg-bg'>
      <div className='flex items-center gap-1 border-b border-border h-12 shrink-0 pl-1.5 pr-2'>
        {onBack && (
          <button type='button' onClick={onBack} aria-label='Back to the chat' className={ACTION}>
            <ArrowLeft size={16} />
          </button>
        )}
        <div
          ref={strip}
          role='tablist'
          onScroll={measure}
          onWheel={(e) => { if (strip.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current.scrollLeft += e.deltaY }}
          style={{ maskImage: fade, WebkitMaskImage: fade }}
          className='flex flex-1 min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden py-1'
        >
          {app && (
            <TabButton selected={active === 'app'} onSelect={() => onActivate('app')} icon={<LayoutGrid size={13} />} title='App' />
          )}
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              selected={active === tab.id}
              onSelect={() => onActivate(tab.id)}
              onDoubleClick={() => !tab.pinned && pin(tab)}
              icon={tab.topic ? <FolderOpen size={13} /> : tab.kind === 'doc' ? <FileText size={13} /> : <Globe size={13} />}
              title={tab.title}
              hint={tab.topic ? `Pinned to ${tab.topic.name} — ${tab.target}` : tab.target}
              temporary={!tab.pinned}
              onPin={!tab.pinned ? () => pin(tab) : undefined}
              // A topic's document is the topic's: removed there, not closed here.
              onClose={tab.topic ? undefined : () => close(tab)}
            />
          ))}
          {threads.map((t) => (
            <TabButton
              key={t.key}
              selected={active === t.key}
              onSelect={() => onActivate(t.key)}
              icon={t.routine ? <Repeat size={13} /> : <Hash size={13} className='text-accent' />}
              title={t.title}
              hint={t.key === 'thread:new' ? 'New side chat' : `${t.routine ? 'Routine' : 'Side chat'} — ${t.title} (double-click to rename)`}
              badge={active !== t.key && t.unread > 0 ? t.unread : undefined}
              onRename={t.key !== 'thread:new' ? (title) => renameThread(t.key, title) : undefined}
              onClose={onCloseThread ? () => onCloseThread(t.key) : undefined}
            />
          ))}
        </div>
        <div className='flex items-center gap-0.5 shrink-0'>
          {activeTab && !activeTab.topic && topicId && (
            <button onClick={() => shareWithTopic(activeTab)} title='Pin to the topic — a tab in each of its chats' className={ACTION}>
              <FolderInput size={14} />
            </button>
          )}
          {activeTab?.topic && (
            <button onClick={() => removeFromTopic(activeTab)} title={`Remove from ${activeTab.topic.name}`} className={ACTION}>
              <FolderMinus size={14} />
            </button>
          )}
          {refresh && (
            <button onClick={refresh} title='Reload' className={ACTION}>
              <RefreshCw size={14} />
            </button>
          )}
          {openUrl && (
            <a href={openUrl} target='_blank' rel='noopener noreferrer' title='Open in new tab' className={ACTION}>
              <ExternalLink size={14} />
            </a>
          )}
          {threadId && onThreadDone && (
            <button type='button' onClick={() => onThreadDone(threadId)} title='Done — put the side chat away' aria-label='Done with this side chat' className={ACTION}>
              <Check size={15} />
            </button>
          )}
          {threadId && (
            <button type='button' onClick={() => navigate(`/c/${threadId}`)} title='Open as a full chat' aria-label='Open as a full chat' className={ACTION}>
              <Maximize2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className='flex-1 min-h-0 flex flex-col'>
        {app && <div className={`${active === 'app' ? 'flex' : 'hidden'} flex-1 min-h-0 flex-col`}>{app.node}</div>}
        {activeTab?.kind === 'doc' && <DocView key={activeTab.id} tab={activeTab} />}
        {activeTab?.kind === 'link' && <LinkView key={activeTab.id} tab={activeTab} />}
        {activeThread && renderThread?.(activeThread.key)}
      </div>
    </div>
  )
}

const ACTION = 'p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'

function TabButton({
  selected, onSelect, onDoubleClick, icon, title, hint, temporary, badge, onPin, onRename, onClose,
}: {
  selected: boolean
  onSelect: () => void
  onDoubleClick?: () => void
  icon: ReactNode
  title: string
  hint?: string
  temporary?: boolean
  /** Unread count, while the tab is in the background. */
  badge?: number
  onPin?: () => void
  /** Double-click edits the title in place. */
  onRename?: (title: string) => void
  onClose?: () => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const save = () => {
    const next = renaming?.trim()
    setRenaming(null)
    if (next && next !== title) onRename?.(next)
  }
  return (
    <div
      role='tab'
      aria-selected={selected}
      title={hint ?? title}
      onClick={onSelect}
      onDoubleClick={onRename ? () => setRenaming(title) : onDoubleClick}
      className={`group flex items-center gap-1.5 h-8 pl-2.5 ${onPin || onClose ? 'pr-1' : 'pr-2.5'} max-w-[13rem] shrink-0 rounded-lg cursor-pointer text-xs select-none transition-colors ${
        selected ? 'bg-surface2 text-text-primary font-medium' : 'text-text-muted hover:text-text-primary hover:bg-surface2/60'
      }`}
    >
      <span className='shrink-0'>{icon}</span>
      {renaming !== null ? (
        <input
          autoFocus
          value={renaming}
          onChange={(e) => setRenaming(e.target.value)}
          onBlur={save}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setRenaming(null) }}
          aria-label='Side chat name'
          className='w-32 min-w-0 rounded border border-border bg-bg px-1 py-0.5 text-xs text-text-primary focus:border-accent focus:outline-none'
        />
      ) : (
        <span className={`truncate ${temporary ? 'italic' : ''}`}>{title}</span>
      )}
      {badge ? <span className='shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-medium text-white'>{badge}</span> : null}
      {onPin && (
        <button
          onClick={(e) => { e.stopPropagation(); onPin() }}
          title='Keep this tab'
          aria-label={`Keep ${title}`}
          className='p-0.5 rounded opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-border transition-opacity'
        >
          <Pin size={11} />
        </button>
      )}
      {onClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          title='Close'
          aria-label={`Close ${title}`}
          className={`p-0.5 rounded hover:bg-border transition-opacity ${selected ? 'opacity-70' : 'opacity-0'} group-hover:opacity-100 [@media(hover:none)]:opacity-70`}
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}

const TEXT_KINDS = /\.(md|markdown|txt|log|csv|json|ya?ml)$/i
const IMAGE_KINDS = /\.(png|jpe?g|gif|webp|svg)$/i

/**
 * A document, rendered. Markdown through the chat's own renderer, other text
 * as-is, everything else (PDF, HTML, images) in a frame. It re-reads whenever
 * the file changes on disk.
 */
function DocView({ tab }: { tab: ChatTab }) {
  const version = useTabsStore((s) => s.versions[tab.id] ?? 0)
  const isText = TEXT_KINDS.test(tab.target)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isText) return
    let cancelled = false
    api.getTabText(tab.conversation_id, tab.id)
      .then((t) => { if (!cancelled) { setText(t); setError(null) } })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [tab.id, tab.conversation_id, isText, version])

  if (error) {
    return (
      <div className='p-6 text-sm text-text-muted'>
        Couldn't open <code>{tab.target}</code>: {error}
      </div>
    )
  }

  const src = `${tabContentUrl(tab)}${tabContentUrl(tab).includes('?') ? '&' : '?'}v=${version}`
  if (!isText) {
    if (IMAGE_KINDS.test(tab.target)) {
      return (
        <div className='flex-1 overflow-auto p-4 flex items-start justify-center'>
          <img src={src} alt={tab.title} className='max-w-full' />
        </div>
      )
    }
    // HTML runs sandboxed (the server sends the same as a CSP): a document is
    // content to read, not an app. PDFs need the browser's own viewer.
    const html = /\.html?$/i.test(tab.target)
    return (
      <iframe
        src={src}
        title={tab.title}
        className='flex-1 w-full border-0 bg-white'
        {...(html ? { sandbox: '' } : {})}
      />
    )
  }

  if (text === null) return <div className='flex-1' data-testid='doc-loading' />
  const markdown = /\.(md|markdown)$/i.test(tab.target)
  return (
    <div className='doc-view flex-1 overflow-y-auto' data-testid='doc-view'>
      {markdown ? (
        <Markdown text={text} className='text-base leading-relaxed max-w-3xl mx-auto px-6 py-5' />
      ) : (
        <pre className='text-xs whitespace-pre-wrap break-words px-5 py-4 font-mono'>{text}</pre>
      )}
    </div>
  )
}

/**
 * A web page beside the chat. Many sites refuse to be framed (and the browser
 * says nothing the page could catch), so the way out is always on screen.
 */
function LinkView({ tab }: { tab: ChatTab }) {
  return (
    <div className='flex-1 min-h-0 flex flex-col'>
      <iframe
        src={tab.target}
        title={tab.title}
        className='flex-1 w-full border-0 bg-white'
        referrerPolicy='no-referrer'
        sandbox='allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
      />
      <div className='shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-text-muted flex items-center gap-2'>
        <span className='truncate flex-1'>{tab.target}</span>
        <a href={tab.target} target='_blank' rel='noopener noreferrer' className='shrink-0 hover:text-text-primary'>
          Blank page? Open in a new tab ↗
        </a>
      </div>
    </div>
  )
}
