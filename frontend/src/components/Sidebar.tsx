import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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
  Code2,
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
import { routineKindOf } from '../lib/threads'
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

function readCollapsed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')
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

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed))
  }, [collapsed])

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
    location.pathname === '/browser' ||
    location.pathname.startsWith('/code')

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
  const children = useNestedThreads(conversations, byId, isOpen)

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
  /** The threads to show under each conversation (useNestedThreads). */
  childrenOf: Map<string, Conversation[]>
}) {
  const renameSection = useChatStore((s) => s.renameSection)
  const deleteSection = useChatStore((s) => s.deleteSection)
  const moveSection = useChatStore((s) => s.moveSection)
  const createConversation = useChatStore((s) => s.createConversation)
  const [renaming, setRenaming] = useState(false)

  const unread = convs.reduce((n, c) => n + (c.unread_count || 0), 0)
  // Collapsed groups still show the open conversation, so navigating into one
  // never makes it disappear.
  const leadsToOpen = (id: string, seen = new Set<string>()): boolean =>
    activePath === `/c/${id}` || (!seen.has(id) && !!childrenOf.get(id)?.some((t) => leadsToOpen(t.id, new Set(seen).add(id))))
  const visible = collapsed ? convs.filter((c) => leadsToOpen(c.id)) : convs
  // Under a conversation, its threads — each with its own, a step further in.
  // Folded, only the way down to the open one.
  const threadRows = (parentId: string, depth: number, seen: Set<string>): React.ReactNode =>
    (childrenOf.get(parentId) ?? [])
      .filter((t) => !seen.has(t.id) && (!collapsed || leadsToOpen(t.id)))
      .map((t) => (
        <Fragment key={t.id}>
          <ConvItem
            conv={t}
            depth={depth}
            active={activePath === `/c/${t.id}`}
            onNav={() => onNav(`/c/${t.id}`)}
            onArchive={() => onArchive(t.id)}
            onRename={(title) => onRename(t.id, title)}
            onMove={(sectionId) => onMove(t.id, sectionId)}
          />
          {threadRows(t.id, depth + 1, new Set(seen).add(t.id))}
        </Fragment>
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
            title={`${unread} unread`}
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
          />
          {threadRows(conv.id, 1, new Set([conv.id]))}
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
}: {
  conv: Conversation
  /** How far under a top-level chat it sits: 0 for the chat itself. */
  depth?: number
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
        // Each level a step further in, from where a chat's own title starts.
        style={nested ? { paddingLeft: 28 + depth * 14 } : undefined}
        className={`
          relative flex items-center ${nested ? '' : CHILD_PAD} pr-3 ${nested ? 'py-1' : 'py-1.5'} rounded-lg cursor-pointer group select-none transition-colors gap-2
          ${active ? 'bg-selected text-text-primary' : 'text-text-secondary hover:bg-surface2'}
        `}
      >
        <span
          className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${nested ? 'text-[13px]' : 'text-sm'} min-w-0 ${unread ? 'font-medium text-text-primary' : ''}`}
        >
          {conv.title}
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
        {unread && (
          <span className='shrink-0 min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-accent text-white text-[11px] font-medium'>
            {conv.unread_count}
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
  { path: '/routines', label: 'Routines', hint: 'What Jarvis does on its own', icon: <Clock size={14} /> },
  { path: '/archive', label: 'Archive', hint: 'Put away, kept a week', icon: <Archive size={14} /> },
  { path: '/settings', label: 'General', hint: 'Appearance, notifications, API keys', icon: <SlidersHorizontal size={14} /> },
  { path: '/settings/customize', label: 'Customize', hint: 'Models, connectors, skills', icon: <Blocks size={14} /> },
  { path: '/browser', label: 'Browser', hint: 'The logged-in Chromium', icon: <Globe size={14} /> },
  { path: '/code', label: 'Code', hint: "Jarvis's source and its changes", icon: <Code2 size={14} /> },
]

/**
 * Settings is a menu of the rarely-visited places, not a page of tabs: each
 * entry is a page of its own, so none is squeezed into a tab's shape.
 */
function SettingsMenu({ active, path, onNav }: { active: boolean; path: string; onNav: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const current = (p: string) => (p === '/code' ? path.startsWith('/code') : path === p)
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

/**
 * Which threads show under which conversation: one that has something for you
 * (unread, or a question waiting) or is open, and every one above it, so the
 * way down to it is there however deep it sits. Put away (Done), a thread
 * shows only while open. A conversation whose parent is gone sits at the top.
 */
function useNestedThreads(
  conversations: Conversation[],
  byId: Map<string, Conversation>,
  isOpen: (c: Conversation) => boolean,
): Map<string, Conversation[]> {
  const kids = new Map<string, Conversation[]>()
  for (const c of conversations) {
    if (c?.parent_id && byId.has(c.parent_id)) kids.set(c.parent_id, [...(kids.get(c.parent_id) ?? []), c])
  }
  const shown = new Map<string, boolean>()
  const visit = (c: Conversation, path: Set<string>): boolean => {
    const known = shown.get(c.id)
    if (known !== undefined) return known
    // A loop in the data shows nothing rather than spinning forever.
    if (path.has(c.id)) return false
    path.add(c.id)
    const own = isOpen(c) || (!c.archived_at && (c.unread_count > 0 || !!c.pending_question))
    let below = false
    for (const k of kids.get(c.id) ?? []) below = visit(k, path) || below
    path.delete(c.id)
    shown.set(c.id, own || below)
    return own || below
  }
  const children = new Map<string, Conversation[]>()
  for (const [parent, list] of kids) {
    const visible = list.filter((k) => visit(k, new Set([parent])))
    if (visible.length) children.set(parent, visible)
  }
  return children
}
