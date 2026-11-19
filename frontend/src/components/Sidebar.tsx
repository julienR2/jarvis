import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { badgeCount } from '../lib/badge'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Plus,
  Clock,
  Link2,
  Archive,
  AppWindow,
  Earth,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderPlus,
  Settings,
  Moon,
  Sun,
  Monitor,
  BellOff,
  RefreshCw,
  SlidersHorizontal,
  Blocks,
  Globe,
  Hash,
} from 'lucide-react'
import { useTheme } from '../hooks/useTheme'
import { hasDraft, useDrafts } from '../lib/drafts'
import { reloadApp } from '../lib/reload'
import { useNotifications } from '../hooks/useNotifications'
import { useLongPress } from '../hooks/useLongPress'
import ConversationMenu, {
  type ConversationMenuHandle,
} from './ConversationMenu'
import NameModal from './NameModal'
import SectionPicker from './SectionPicker'
import Popover from './Popover'
import type { Conversation, Section } from '../api'
import { useChatStore } from '../stores/chatStore'
import { api } from '../api'
import { startOfToday, useRecentRuns } from '../lib/runs'
import { routineKindOf, threadTitle } from '../lib/threads'
import { useShallow } from 'zustand/react/shallow'

interface Props {
  onNew: () => void
  onArchive: (id: string) => void
  onRename: (id: string, title: string) => void
  onMove: (id: string, sectionId: string | null) => void
  onSelect: () => void
  /** Desktop only — omitted on mobile, where `w-64` applies. */
  width?: number
}

/** Collapse state is per-device, so localStorage rather than the DB. */
const COLLAPSE_KEY = 'sidebar-sections-collapsed'
/** The chats whose threads are all listed, not only the ones with news. Per device too. */
const THREADS_OPEN_KEY = 'sidebar-threads-open'
/**
 * A chat's emoji and the space after it, at the sidebar's 14px: about 22px
 * (21 with Noto, 22 with Apple's). A thread's # starts where the chat's
 * title starts, so it reads as under it; its own title follows at the
 * row's usual gap — a # is narrower than an emoji, and the emoji's width
 * after it left a hole.
 */
const EMOJI_SLOT = 22
/** Lucide's # is drawn 2px inside its 12px box: shifted back, the mark itself lines up. */
const HASH_INSET = 2
const THREAD_PAD = 28 + EMOJI_SLOT - HASH_INSET
/**
 * Touch devices never hover, so a hover-revealed section menu would be
 * unreachable there — show it permanently instead.
 */
const CAN_HOVER = window.matchMedia('(hover: hover)').matches
/** Stand-in id for the default group, which has no row of its own. */
const DEFAULT_ID = '__default__'
/**
 * Indents a row under its section header, roughly past the emoji most section
 * names start with — the header itself has no chevron, so its name sits flush at
 * px-3. The row background still spans the full sidebar width.
 */
const CHILD_PAD = 'pl-7'

function readCollapsed(key = COLLAPSE_KEY): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export default function Sidebar({
  onNew,
  onArchive,
  onRename,
  onMove,
  onSelect,
  width,
}: Props) {
  const conversations = useChatStore(
    useShallow((s) => s.order.map((id) => s.conversations[id])),
  )
  const sections = useChatStore(useShallow((s) => s.sections))
  const createSection = useChatStore((s) => s.createSection)
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed)
  const [creatingSection, setCreatingSection] = useState(false)
  const [threadsOpen, setThreadsOpen] = useState<string[]>(() => readCollapsed(THREADS_OPEN_KEY))

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed))
  }, [collapsed])
  useEffect(() => {
    localStorage.setItem(THREADS_OPEN_KEY, JSON.stringify(threadsOpen))
  }, [threadsOpen])
  const toggleThreads = useCallback(
    (id: string) => setThreadsOpen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    [],
  )

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }, [])

  const navigate = useNavigate()
  const location = useLocation()
  const { permission, requestPermission } = useNotifications()
  const { theme, preference, cycle } = useTheme()

  // Everything the Settings menu opens lights it up.
  const onSettings =
    location.pathname.startsWith('/settings') ||
    location.pathname.startsWith('/routines') ||
    location.pathname === '/archive' ||
    location.pathname === '/browser'

  function handleNav(path: string) {
    // On mobile, fully animate the sidebar closed before navigating, so the
    // back-navigation snapshot the system caches already shows it closed.
    const isMobile = !window.matchMedia('(min-width: 768px)').matches
    if (isMobile) {
      onSelect()
      setTimeout(() => navigate(path), 220)
    } else {
      navigate(path)
    }
  }

  // Sections in their own order, then the default group last — conversations
  // inside each stay sorted by most recent activity (the store's list order).
  // A conversation under another (a thread) is listed under it, not here.
  const isOpen = (c: Conversation) => location.pathname === `/c/${c.id}`
  const byId = new Map(conversations.filter(Boolean).map((c) => [c.id, c]))
  const chats = conversations.filter((c) => c && !(c.parent_id && byId.has(c.parent_id)) && (!c.archived_at || isOpen(c)))
  const groups: { id: string; section: Section | null; convs: Conversation[] }[] = [
    ...sections.map((section) => ({
      id: section.id,
      section,
      convs: chats.filter((c) => c.section_id === section.id),
    })),
    {
      id: DEFAULT_ID,
      section: null,
      convs: chats.filter((c) => !c.section_id),
    },
  ]
  const children = useNestedThreads(conversations, byId, isOpen, threadsOpen)

  return (
    <aside
      // Width comes from the parent on desktop, where the seam is draggable.
      // Left to `w-64` on mobile: there the sidebar is an overlay, and a width
      // dragged on a laptop has no business narrowing a phone's.
      className={`${width ? '' : 'w-64'} bg-bg-alt flex flex-col h-full shrink-0 border-r border-border safe-area-insets`}
      style={width ? { width } : undefined}
    >
      {/* Header */}
      <div className='px-3 pt-4 pb-2 space-y-0.5'>
        {/* Home, and a step above the two actions under it: the one place to
            start from, so it reads as a place rather than another button. */}
        <button
          onClick={() => handleNav('/')}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${location.pathname === '/' ? 'text-text-primary bg-selected' : 'text-text-primary hover:bg-surface2'}`}
        >
          <Sun size={16} className='text-accent' />
          <span>Today</span>
          <StatusDot />
        </button>
        <button
          onClick={onNew}
          className='w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-text-secondary hover:bg-surface2 transition-colors'
        >
          <Plus size={16} />
          <span>New chat</span>
        </button>
        {/* Same shape and weight as New chat. Kept out of the scroll area so it
            stays reachable however many chats are in the list. */}
        <button
          onClick={() => setCreatingSection(true)}
          className='w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-text-secondary hover:bg-surface2 transition-colors'
        >
          <FolderPlus size={16} />
          <span>New topic</span>
        </button>
        {creatingSection && (
          <NameModal
            title='New topic'
            placeholder='Work, Home, a project…'
            confirmLabel='Create'
            onSubmit={(name) => createSection(name)}
            onClose={() => setCreatingSection(false)}
          />
        )}
      </div>
      <div className='mx-4 mb-1 h-px bg-border' />

      {/* Scrollable list */}
      {/* Groups sit tight against each other; the breathing room lives *inside* an
          expanded group (see SectionGroup) so a run of collapsed headers reads as
          a compact list rather than a widely spaced one. */}
      <div className='flex-1 overflow-y-auto px-2 pb-2 flex flex-col'>
        {chats.length === 0 && (
          <div className='px-3 py-6 text-text-muted text-xs text-center'>
            No conversations yet
          </div>
        )}

        {groups.map((group, i) => (
          <SectionGroup
            key={group.id}
            section={group.section}
            convs={group.convs}
            collapsed={collapsed.includes(group.id)}
            onToggle={() => toggleCollapsed(group.id)}
            canMoveUp={i > 0}
            canMoveDown={!!group.section && i < sections.length - 1}
            activePath={location.pathname}
            onNav={handleNav}
            onArchive={onArchive}
            onRename={onRename}
            onMove={onMove}
            childrenOf={children}
            threadsOpen={threadsOpen}
            onToggleThreads={toggleThreads}
          />
        ))}

      </div>

      {/* Bottom nav: the Settings menu, plus the one-click toggles kept at hand. */}
      <div className='border-t border-border p-2'>
        <div className='flex items-center gap-1'>
          <div className='flex-1'>
            <SettingsMenu active={onSettings} path={location.pathname} onNav={handleNav} />
          </div>
          <button
            onClick={reloadApp}
            title='Reload app'
            className='p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'
          >
            <RefreshCw size={15} />
          </button>
          {permission !== 'granted' && (
            <button
              onClick={requestPermission}
              title='Enable notifications'
              className='p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'
            >
              <BellOff size={15} />
            </button>
          )}
          <button
            onClick={cycle}
            title={`Theme: ${preference} (click to change)`}
            className='p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'
          >
            {preference === 'system' ? (
              <Monitor size={15} />
            ) : theme === 'dark' ? (
              <Moon size={15} />
            ) : (
              <Sun size={15} />
            )}
          </button>
        </div>
      </div>
    </aside>
  )
}

/**
 * One collapsible sidebar group. `section` is null for the default "Chats" group,
 * which can't be renamed, moved, or deleted — and has no page: a topic's name
 * opens its page, the chevron beside it folds the list.
 */
function SectionGroup({
  section,
  convs,
  collapsed,
  onToggle,
  canMoveUp,
  canMoveDown,
  activePath,
  onNav,
  onArchive,
  onRename,
  onMove,
  childrenOf,
  threadsOpen,
  onToggleThreads,
}: {
  section: Section | null
  convs: Conversation[]
  collapsed: boolean
  onToggle: () => void
  canMoveUp: boolean
  canMoveDown: boolean
  activePath: string
  onNav: (path: string) => void
  onArchive: (id: string) => void
  onRename: (id: string, title: string) => void
  onMove: (id: string, sectionId: string | null) => void
  /** The threads to show under each chat (useNestedThreads). */
  childrenOf: Map<string, ChatThreads>
  threadsOpen: string[]
  onToggleThreads: (id: string) => void
}) {
  const renameSection = useChatStore((s) => s.renameSection)
  const deleteSection = useChatStore((s) => s.deleteSection)
  const moveSection = useChatStore((s) => s.moveSection)
  const createConversation = useChatStore((s) => s.createConversation)
  const [renaming, setRenaming] = useState(false)

  const unread = convs.reduce((n, c) => n + badgeCount(c), 0)
  // Collapsed groups still show the open conversation, so navigating into one
  // never makes it disappear.
  const isActive = (id: string) => activePath === `/c/${id}`
  const leadsToOpen = (id: string): boolean => isActive(id) || !!childrenOf.get(id)?.shown.some((t) => isActive(t.id))
  const visible = collapsed ? convs.filter((c) => leadsToOpen(c.id)) : convs
  // Under a chat, its threads — one level, however deep they sit (a thread of
  // a thread is listed with the others). Folded group: only the open one.
  const threadRows = (chatId: string): React.ReactNode =>
    (childrenOf.get(chatId)?.shown ?? [])
      .filter((t) => !collapsed || isActive(t.id))
      .map((t) => (
        <ConvItem
          key={t.id}
          conv={t}
          depth={1}
          active={isActive(t.id)}
          onNav={() => onNav(`/c/${t.id}`)}
          onArchive={() => onArchive(t.id)}
          onRename={(title) => onRename(t.id, title)}
          onMove={(sectionId) => onMove(t.id, sectionId)}
        />
      ))

  return (
    // Top padding stays put whether open or closed, so toggling doesn't nudge the
    // header down; only the bottom grows, which is what sets an expanded group apart.
    <div
      className={`gap-0.5 flex flex-col ${
        collapsed ? 'py-1.5' : 'pt-1.5 pb-4'
      }`}
    >
      {/* Same height as a chat row (py-1.5 + a 20px line), so a topic reads as an
          entry of the list rather than a thinner label squeezed between rows. */}
      <div className={`h-8 flex items-center group/section pr-3 rounded-lg ${section && activePath === `/t/${section.id}` ? 'bg-selected' : ''}`}>
        <button
          onClick={onToggle}
          title={collapsed ? 'Show the chats' : 'Fold the chats'}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${section ? section.name : 'Chats'}`}
          className='shrink-0 self-stretch pl-1.5 text-text-muted/50 hover:text-text-secondary transition-colors'
        >
          <ChevronRight size={11} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        </button>
        <button
          onClick={section ? () => onNav(`/t/${section.id}`) : onToggle}
          title={section ? 'Open the topic' : undefined}
          className={`flex-1 self-stretch flex items-center pl-1.5 pr-3 min-w-0 text-[11px] font-semibold uppercase tracking-wider transition-colors ${section && activePath === `/t/${section.id}` ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
        >
          <span className='truncate'>{section ? section.name : 'Chats'}</span>
        </button>
        {/* Only unread is worth a badge here — a plain chat count on every group
            was more noise than signal. An empty group still reads as empty via
            its "Empty — move a chat here" row, which a collapsed one never shows. */}
        {collapsed && unread > 0 && (
          <span
            className='shrink-0 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-accent text-white text-[10px] font-semibold tabular-nums'
            title={`${unread} waiting`}
          >
            {unread}
          </span>
        )}
        {section && (
          <SectionMenu
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            onNewChat={async () => {
              const conv = await createConversation(undefined, section.id)
              onNav(`/c/${conv.id}`)
            }}
            onRename={() => setRenaming(true)}
            onMoveUp={() => moveSection(section.id, -1)}
            onMoveDown={() => moveSection(section.id, 1)}
            onDelete={() => {
              if (
                confirm(
                  `Delete the topic "${section.name}"? Its chats move back to Chats; its brief is lost.`,
                )
              )
                deleteSection(section.id)
            }}
          />
        )}
      </div>
      {renaming && section && (
        <NameModal
          title='Rename topic'
          initialValue={section.name}
          onSubmit={(name) => renameSection(section.id, name)}
          onClose={() => setRenaming(false)}
        />
      )}
      {visible.map((conv) => (
        <Fragment key={conv.id}>
          <ConvItem
            conv={conv}
            active={activePath === `/c/${conv.id}`}
            onNav={() => onNav(`/c/${conv.id}`)}
            onArchive={() => onArchive(conv.id)}
            onRename={(title) => onRename(conv.id, title)}
            onMove={(sectionId) => onMove(conv.id, sectionId)}
            threads={
              childrenOf.get(conv.id)?.total
                ? { open: threadsOpen.includes(conv.id), onToggle: () => onToggleThreads(conv.id) }
                : undefined
            }
          />
          {threadRows(conv.id)}
        </Fragment>
      ))}
      {!collapsed && convs.length === 0 && (
        <div className={`${CHILD_PAD} pr-3 py-1 text-[11px] text-text-muted/70 italic`}>
          {section ? 'Empty — move a chat here' : 'No chats'}
        </div>
      )}
    </div>
  )
}

/** Per-section ⋯ menu. Reordering is up/down rather than drag-and-drop. */
function SectionMenu({
  canMoveUp,
  canMoveDown,
  onNewChat,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  canMoveUp: boolean
  canMoveDown: boolean
  onNewChat: () => void
  onRename: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  return (
    <div className='relative shrink-0'>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        title='Topic options'
        className={`p-1 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors ${
          open
            ? 'bg-surface2 text-text-primary'
            : CAN_HOVER
              ? 'hidden group-hover/section:block'
              : 'block'
        }`}
      >
        <MoreHorizontal size={14} />
      </button>
      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} className='min-w-[150px] bg-surface border border-border rounded-xl shadow-md/5 p-1'>
          <MenuButton
            icon={<Plus size={14} />}
            label='New chat'
            onClick={() => {
              setOpen(false)
              onNewChat()
            }}
          />
          <MenuButton
            icon={<Pencil size={14} />}
            label='Rename'
            onClick={() => {
              setOpen(false)
              onRename()
            }}
          />
          {canMoveUp && (
            <MenuButton
              icon={<ChevronUp size={14} />}
              label='Move up'
              onClick={() => {
                setOpen(false)
                onMoveUp()
              }}
            />
          )}
          {canMoveDown && (
            <MenuButton
              icon={<ChevronDown size={14} />}
              label='Move down'
              onClick={() => {
                setOpen(false)
                onMoveDown()
              }}
            />
          )}
          <MenuButton
            icon={<Trash2 size={14} />}
            label='Delete'
            danger
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          />
      </Popover>
    </div>
  )
}

function MenuButton({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2 py-1.5 text-sm rounded-lg hover:bg-surface2 transition-colors ${
        danger ? 'text-danger' : 'text-text-secondary'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function ConvItem({
  conv,
  active,
  onNav,
  onArchive,
  onRename,
  onMove,
  depth = 0,
  threads,
}: {
  conv: Conversation
  /** 1 for a thread listed under its chat, 0 for the chat itself. */
  depth?: number
  /** A chat that has threads: whether all of them are listed, and the switch. */
  threads?: { open: boolean; onToggle: () => void }
  active: boolean
  onNav: () => void
  onArchive: () => void
  onRename: (title: string) => void
  onMove: (sectionId: string | null) => void
}) {
  const nested = depth > 0
  const menuRef = useRef<ConversationMenuHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const unread = conv.unread_count > 0 && !active
  // The number: what its app set (jarvis.setBadge), else its unread replies.
  const badge = badgeCount(conv, active)
  // Something typed or attached here and left unsent — shown, as in Slack,
  // on the chats you are not in.
  const drafted = useDrafts((s) => hasDraft(s[conv.id])) && !active
  const [renaming, setRenaming] = useState(false)
  const [moving, setMoving] = useState(false)

  const longPress = useLongPress(() => {
    menuRef.current?.open()
  })

  return (
    <>
      {renaming && (
        <NameModal
          title='Edit name'
          initialValue={conv.title}
          onSubmit={(title) => {
            if (title !== conv.title) onRename(title)
          }}
          onClose={() => setRenaming(false)}
        />
      )}
      {moving && (
        <SectionPicker
          currentId={conv.section_id}
          onPick={onMove}
          onClose={() => setMoving(false)}
        />
      )}
      <div
        ref={containerRef}
        onClick={onNav}
        {...longPress}
        style={nested ? { paddingLeft: THREAD_PAD } : undefined}
        className={`
          relative flex items-center ${nested ? '' : CHILD_PAD} pr-3 ${nested ? 'py-1' : 'py-1.5'} rounded-lg cursor-pointer group select-none transition-colors gap-2
          ${active ? 'bg-selected text-text-primary' : 'text-text-secondary hover:bg-surface2'}
        `}
      >
        {/* In the gutter left of the title: list all its threads, or only the
            ones with news. Shown on hover, and always once open. */}
        {threads && (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              threads.onToggle()
            }}
            title={threads.open ? 'Only the threads with news' : 'All its threads'}
            aria-label={threads.open ? 'Hide its threads' : 'Show its threads'}
            aria-expanded={threads.open}
            className={`absolute left-1.5 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-text-muted/60 hover:text-text-secondary ${threads.open || !CAN_HOVER ? '' : 'opacity-0 group-hover:opacity-100'}`}
          >
            <ChevronRight size={11} className={`transition-transform ${threads.open ? 'rotate-90' : ''}`} />
          </button>
        )}
        {nested && (
          <span className='shrink-0 flex items-center'>
            <Hash size={12} className='text-text-muted/70' />
          </span>
        )}
        <span
          className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${nested ? 'text-[13px]' : 'text-sm'} min-w-0 ${unread ? 'font-medium text-text-primary' : nested && !active ? 'text-text-muted' : ''}`}
        >
          {nested ? threadTitle(conv.title) : conv.title}
        </span>
        <span className='flex items-center gap-2 shrink-0'>
          {drafted && (
            <span title='Draft' data-testid='draft-marker'>
              <Pencil size={11} className='text-accent' />
            </span>
          )}
          {!!conv.app_path && (
            <span title='App'>
              <AppWindow size={11} className='text-text-muted' />
            </span>
          )}
          {/* What feeds it besides you: a schedule, or a webhook. */}
          {routineKindOf(conv) === 'cron' && (
            <span title='Runs on a schedule' data-testid='routine-mark'>
              <Clock size={11} className='text-text-muted' />
            </span>
          )}
          {routineKindOf(conv) === 'webhook' && (
            <span title='Runs when its webhook is called' data-testid='routine-mark'>
              <Link2 size={11} className='text-text-muted' />
            </span>
          )}
          {!!conv.share_mode && (
            <span title={conv.share_mode === 'write' ? 'Shared — can reply' : 'Shared — read-only'}>
              <Earth size={11} className='text-text-muted' />
            </span>
          )}
        </span>
        {nested && !!conv.pending_question && !active && (
          <span className='shrink-0 h-2 w-2 rounded-full bg-warning' title='Waiting for you' data-testid='waiting-dot' />
        )}
        {badge > 0 && (
          <span className='shrink-0 min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-accent text-white text-[11px] font-medium' data-testid='chat-badge'>
            {badge}
          </span>
        )}
        <ConversationMenu
          ref={menuRef}
          conversationId={conv.id}
          onArchive={onArchive}
          onRename={() => setRenaming(true)}
          onMove={() => setMoving(true)}
          triggerClassName='hidden group-hover:flex'
          compact
        />
      </div>
    </>
  )
}

const SETTINGS_ITEMS: { path: string; label: string; hint: string; icon: React.ReactNode }[] = [
  { path: '/settings', label: 'General', hint: 'Appearance, notifications, API keys', icon: <SlidersHorizontal size={14} /> },
  { path: '/routines', label: 'Routines', hint: 'What Jarvis does on its own', icon: <Clock size={14} /> },
  { path: '/settings/customize', label: 'Capabilities', hint: 'Models, connectors, apps, skills', icon: <Blocks size={14} /> },
  { path: '/browser', label: 'Browser', hint: 'The logged-in Chromium', icon: <Globe size={14} /> },
  { path: '/archive', label: 'Archive', hint: 'Put away, kept a week', icon: <Archive size={14} /> },
]

/**
 * Settings is a menu of the rarely-visited places, not a page of tabs: each
 * entry is a page of its own, so none is squeezed into a tab's shape.
 */
function SettingsMenu({ active, path, onNav }: { active: boolean; path: string; onNav: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = (p: string) => path === p
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup='menu'
        aria-expanded={open}
        className={`w-full text-left px-3 py-2 text-sm rounded-lg flex items-center gap-2.5 transition-colors ${
          active || open ? 'text-text-primary bg-selected' : 'text-text-secondary hover:text-text-primary hover:bg-surface2'
        }`}
      >
        <Settings size={15} />
        Settings
      </button>
      <Popover anchor={btnRef} open={open} onClose={() => setOpen(false)} placement='top-start' className='w-64 bg-surface border border-border rounded-xl shadow-md/5 p-1'>
        <div role='menu'>
          {SETTINGS_ITEMS.map((item) => (
            <button
              key={item.path}
              role='menuitem'
              onClick={() => { setOpen(false); onNav(item.path) }}
              className={`w-full flex items-start gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors ${current(item.path) ? 'bg-selected' : 'hover:bg-surface2'}`}
            >
              <span className='mt-0.5 text-text-muted'>{item.icon}</span>
              <span className='min-w-0'>
                <span className='block text-sm text-text-primary'>{item.label}</span>
                <span className='block text-[11px] text-text-muted truncate'>{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

/**
 * Today's signal, in order of urgency: something waits on you (amber),
 * something is running now (accent, pulsing), something failed today (red).
 * Read from the shared recent runs feed. Today is where all three are acted on,
 * so the dot sits on its entry — there is no Activity page to point at.
 */
function StatusDot() {
  const { runs } = useRecentRuns()
  const startOfDay = startOfToday()
  const waiting = !!runs?.some((r) => r.status === 'needs_you')
  const running = !waiting && !!runs?.some((r) => r.status === 'running')
  const failedToday = !!runs?.some((r) => r.status === 'error' && r.started_at >= startOfDay)
  if (waiting) return <span className='ml-auto h-2 w-2 rounded-full bg-warning' title='Jarvis is waiting for you' data-testid='activity-waiting' />
  if (running) return <span className='ml-auto h-2 w-2 rounded-full bg-accent animate-pulse' title='Something is running' data-testid='activity-running' />
  if (failedToday) return <span className='ml-auto h-2 w-2 rounded-full bg-danger' title='Something failed today' data-testid='activity-failed' />
  return null
}

/** A chat's threads in the sidebar: the ones listed, and how many it has. */
interface ChatThreads {
  shown: Conversation[]
  total: number
}

/**
 * Which threads show under which chat. Every thread is listed under its
 * top-level chat, one level, however deep it sits. Listed: the open one, and
 * the ones with something for you (unread, a question waiting) — or all of
 * them, for a chat whose threads were unfolded. Put away, a thread shows only
 * while open. A conversation whose parent is gone sits at the top.
 */
function useNestedThreads(
  conversations: Conversation[],
  byId: Map<string, Conversation>,
  isOpen: (c: Conversation) => boolean,
  unfolded: string[],
): Map<string, ChatThreads> {
  const rootOf = (c: Conversation): string | null => {
    const seen = new Set<string>()
    let cur = c
    while (cur.parent_id && byId.has(cur.parent_id)) {
      // A loop in the data lists nothing rather than spinning forever.
      if (seen.has(cur.id)) return null
      seen.add(cur.id)
      cur = byId.get(cur.parent_id)!
    }
    return cur.id === c.id ? null : cur.id
  }
  const out = new Map<string, ChatThreads>()
  for (const c of conversations) {
    if (!c?.parent_id) continue
    const root = rootOf(c)
    if (!root) continue
    const entry = out.get(root) ?? { shown: [], total: 0 }
    if (!c.archived_at) entry.total++
    const news = !c.archived_at && (c.unread_count > 0 || !!c.pending_question)
    if (isOpen(c) || news || (!c.archived_at && unfolded.includes(root))) entry.shown.push(c)
    out.set(root, entry)
  }
  return out
}
