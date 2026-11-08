import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink, FileText, FolderInput, FolderMinus, FolderOpen, Globe, LayoutGrid, Pin, RefreshCw, X } from 'lucide-react'
import { api, tabContentUrl, type ChatTab } from '../api'
import { useTabsStore } from '../stores/tabsStore'
import { Markdown } from './MessageBubble'

/** What the side pane shows: the chat's app, or one of its tabs. */
export type PanelKey = 'app' | string

interface Props {
  conversationId: string
  tabs: ChatTab[]
  active: PanelKey
  onActivate: (key: PanelKey) => void
  /** The chat's app, already built — kept mounted while another tab is shown, so it keeps its state. */
  app?: { node: ReactNode; onRefresh: () => void; url?: string }
  /** The chat's topic, when it has one: its tabs can be shared with it. */
  topicId?: string | null
}

/**
 * The pane beside the chat once it holds more than the app: a strip of tabs —
 * the app first, then documents and links in the order they were opened — and
 * the one selected. The temporary tab (unpinned, replaced by the next one
 * opened) is in italics, as in an editor's preview tab; double-click or the
 * pin keeps it.
 */
export default function SidePanel({ conversationId, tabs, active, onActivate, app, topicId }: Props) {
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

  const openUrl = activeTab ? (activeTab.kind === 'link' ? activeTab.target : tabContentUrl(activeTab)) : app?.url
  const refresh = activeTab ? () => bump(activeTab.id) : app?.onRefresh

  return (
    <div className='flex flex-col h-full bg-bg'>
      <div className='flex items-stretch border-b border-border h-10 shrink-0'>
        <div className='flex flex-1 min-w-0 overflow-x-auto' role='tablist'>
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
        </div>
        <div className='flex items-center gap-0.5 px-2 shrink-0'>
          {activeTab && !activeTab.topic && topicId && (
            <button onClick={() => shareWithTopic(activeTab)} title='Pin to the topic — a tab in each of its chats' className='p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'>
              <FolderInput size={13} />
            </button>
          )}
          {activeTab?.topic && (
            <button onClick={() => removeFromTopic(activeTab)} title={`Remove from ${activeTab.topic.name}`} className='p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'>
              <FolderMinus size={13} />
            </button>
          )}
          {refresh && (
            <button onClick={refresh} title='Reload' className='p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'>
              <RefreshCw size={13} />
            </button>
          )}
          {openUrl && (
            <a href={openUrl} target='_blank' rel='noopener noreferrer' title='Open in new tab' className='p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'>
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>

      <div className='flex-1 min-h-0 flex flex-col'>
        {app && <div className={`${active === 'app' ? 'flex' : 'hidden'} flex-1 min-h-0 flex-col`}>{app.node}</div>}
        {activeTab?.kind === 'doc' && <DocView key={activeTab.id} tab={activeTab} />}
        {activeTab?.kind === 'link' && <LinkView key={activeTab.id} tab={activeTab} />}
      </div>
    </div>
  )
}

function TabButton({
  selected, onSelect, onDoubleClick, icon, title, hint, temporary, onPin, onClose,
}: {
  selected: boolean
  onSelect: () => void
  onDoubleClick?: () => void
  icon: ReactNode
  title: string
  hint?: string
  temporary?: boolean
  onPin?: () => void
  onClose?: () => void
}) {
  return (
    <div
      role='tab'
      aria-selected={selected}
      title={hint ?? title}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      className={`group flex items-center gap-1.5 pl-3 pr-1.5 max-w-[14rem] shrink-0 cursor-pointer border-r border-border text-xs select-none transition-colors ${
        selected ? 'bg-surface text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-surface2'
      }`}
    >
      <span className='shrink-0'>{icon}</span>
      <span className={`truncate ${temporary ? 'italic' : ''}`}>{title}</span>
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
          className='p-0.5 rounded opacity-60 group-hover:opacity-100 hover:bg-border transition-opacity'
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
