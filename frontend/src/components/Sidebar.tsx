import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Plus,
  Clock,
  Repeat,
  AppWindow,
  Link2,
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
} from 'lucide-react'
import { useTheme } from '../hooks/useTheme'
import { reloadApp } from '../lib/reload'
import { useNotifications } from '../hooks/useNotifications'
import { useLongPress } from '../hooks/useLongPress'
import ConversationMenu, {
  type ConversationMenuHandle,
} from './ConversationMenu'
import NameModal from './NameModal'
import SectionPicker from './SectionPicker'
import type { Conversation, Section } from '../api'
import { useChatStore } from '../stores/chatStore'
import { api } from '../api'
import { startOfToday, useRecentRuns } from '../lib/runs'
import { useShallow } from 'zustand/react/shallow'

interface Props {
  onNew: () => void
  onDelete: (id: string) => void
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
  onDelete,
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

  // Settings owns its tabs and the two full-height tools reached from Advanced.
  const onSettings =
    location.pathname === '/settings' ||
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
  const groups: { id: string; section: Section | null; convs: Conversation[] }[] = [
    ...sections.map((section) => ({
      id: section.id,
      section,
      convs: conversations.filter((c) => c?.section_id === section.id),
    })),
    {
      id: DEFAULT_ID,
      section: null,
      convs: conversations.filter((c) => c && !c.section_id),
    },
  ]

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
        <button
          onClick={() => handleNav('/')}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${location.pathname === '/' ? 'text-text-primary bg-selected' : 'text-text-secondary hover:bg-surface2'}`}
        >
          <Sun size={16} />
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
        {/* Same shape as New chat, one step dimmer. Kept out of the scroll area
            so it stays reachable however many chats are in the list. */}
        <button
          onClick={() => setCreatingSection(true)}
          className='w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-text-muted hover:bg-surface2 transition-colors'
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

      {/* Scrollable list */}
      {/* Groups sit tight against each other; the breathing room lives *inside* an
          expanded group (see SectionGroup) so a run of collapsed headers reads as
          a compact list rather than a widely spaced one. */}
      <div className='flex-1 overflow-y-auto px-2 pb-2 flex flex-col'>
        {conversations.length === 0 && (
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
            onDelete={onDelete}
            onRename={onRename}
            onMove={onMove}
          />
        ))}

      </div>

      {/* Bottom nav: Settings, plus the three one-click toggles kept at hand.
          Logout moved into Settings › Overview. */}
      <div className='border-t border-border p-2'>
        <NavItem
          label='Routines'
          icon={<Repeat size={15} />}
          active={location.pathname === '/routines'}
          onClick={() => handleNav('/routines')}
        />
        <div className='flex items-center gap-1'>
          <div className='flex-1'>
            <NavItem
              label='Settings'
              icon={<Settings size={15} />}
              active={onSettings}
              onClick={() => handleNav('/settings')}
            />
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
  onDelete,
  onRename,
  onMove,
}: {
  section: Section | null
  convs: Conversation[]
  collapsed: boolean
  onToggle: () => void
  canMoveUp: boolean
  canMoveDown: boolean
  activePath: string
  onNav: (path: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onMove: (id: string, sectionId: string | null) => void
}) {
  const renameSection = useChatStore((s) => s.renameSection)
  const deleteSection = useChatStore((s) => s.deleteSection)
  const moveSection = useChatStore((s) => s.moveSection)
  const [renaming, setRenaming] = useState(false)
  const navigate = useNavigate()

  const unread = convs.reduce((n, c) => n + (c.unread_count || 0), 0)
  // Collapsed groups still show the open conversation, so navigating into one
  // never makes it disappear.
  const visible = collapsed
    ? convs.filter((c) => activePath === `/c/${c.id}`)
    : convs

  return (
    // Top padding stays put whether open or closed, so toggling doesn't nudge the
    // header down; only the bottom grows, which is what sets an expanded group apart.
    <div
      className={`gap-0.5 flex flex-col ${
        collapsed ? 'py-1.5' : 'pt-1.5 pb-4'
      }`}
    >
      <div className={`flex items-center group/section pr-1 rounded-lg ${section && activePath === `/t/${section.id}` ? 'bg-selected' : ''}`}>
        <button
          onClick={onToggle}
          title={collapsed ? 'Show the chats' : 'Fold the chats'}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${section ? section.name : 'Chats'}`}
          className='shrink-0 pl-1.5 py-1 text-text-muted/50 hover:text-text-secondary transition-colors'
        >
          <ChevronRight size={11} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        </button>
        <button
          onClick={section ? () => onNav(`/t/${section.id}`) : onToggle}
          title={section ? 'Open the topic' : undefined}
          className={`flex-1 flex items-center pl-1.5 pr-3 py-1 min-w-0 text-[11px] font-semibold uppercase tracking-wider transition-colors ${section && activePath === `/t/${section.id}` ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
        >
          <span className='truncate'>{section ? section.name : 'Chats'}</span>
        </button>
        {/* Only unread is worth a badge here — a plain chat count on every group
            was more noise than signal. An empty group still reads as empty via
            its "Empty — move a chat here" row, which a collapsed one never shows. */}
        {collapsed && unread > 0 && (
          <span className='shrink-0 min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-accent text-white text-[11px] font-medium'>
            {unread}
          </span>
        )}
        {section && (
          <SectionMenu
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            onRoutines={() => navigate(`/routines?section_id=${section.id}`)}
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
        <ConvItem
          key={conv.id}
          conv={conv}
          active={activePath === `/c/${conv.id}`}
          onNav={() => onNav(`/c/${conv.id}`)}
          onDelete={() => onDelete(conv.id)}
          onRename={(title) => onRename(conv.id, title)}
          onMove={(sectionId) => onMove(conv.id, sectionId)}
        />
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
  onRoutines,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  canMoveUp: boolean
  canMoveDown: boolean
  onRoutines: () => void
  onRename: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleOutside(e: MouseEvent | TouchEvent) {
      if (containerRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('click', handleOutside)
    window.addEventListener('touchstart', handleOutside)
    return () => {
      window.removeEventListener('click', handleOutside)
      window.removeEventListener('touchstart', handleOutside)
    }
  }, [open])

  return (
    <div ref={containerRef} className='relative shrink-0'>
      <button
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
      {open && (
        <div className='absolute right-0 top-full mt-1 z-[200] min-w-[150px] bg-surface border border-border rounded-xl shadow-md/5 p-1'>
          <MenuButton
            icon={<Repeat size={14} />}
            label='Routines'
            onClick={() => {
              setOpen(false)
              onRoutines()
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
        </div>
      )}
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
  onDelete,
  onRename,
  onMove,
}: {
  conv: Conversation
  active: boolean
  onNav: () => void
  onDelete: () => void
  onRename: (title: string) => void
  onMove: (sectionId: string | null) => void
}) {
  const navigate = useNavigate()
  const menuRef = useRef<ConversationMenuHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const unread = conv.unread_count > 0 && !active
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
        className={`
          relative flex items-center ${CHILD_PAD} pr-3 py-1.5 rounded-lg cursor-pointer group select-none transition-colors gap-2
          ${active ? 'bg-selected text-text-primary' : 'text-text-secondary hover:bg-surface2'}
        `}
      >
        <span
          className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm min-w-0 ${unread ? 'font-medium text-text-primary' : ''}`}
        >
          {conv.title}
        </span>
        <span className='flex items-center gap-2 shrink-0'>
          {!!conv.app_path && (
            <span title='App'>
              <AppWindow size={11} className='text-text-muted' />
            </span>
          )}
          {!!conv.has_cron && (
            <span
              title='Cron'
              className='hover:text-accent transition-colors cursor-pointer'
              onClick={(e) => { e.stopPropagation(); navigate(`/routines?conversation_id=${conv.id}`) }}
            >
              <Clock size={11} className='text-text-muted hover:text-accent' />
            </span>
          )}
          {!!conv.has_webhook && (
            <span
              title='Webhook'
              className='hover:text-accent transition-colors cursor-pointer'
              onClick={(e) => { e.stopPropagation(); navigate(`/routines?conversation_id=${conv.id}`) }}
            >
              <Link2 size={11} className='text-text-muted hover:text-accent' />
            </span>
          )}
          {!!conv.share_mode && (
            <span title={conv.share_mode === 'write' ? 'Shared — can reply' : 'Shared — read-only'}>
              <Earth size={11} className='text-text-muted' />
            </span>
          )}
        </span>
        {unread && (
          <span className='shrink-0 min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-accent text-white text-[11px] font-medium'>
            {conv.unread_count}
          </span>
        )}
        <ConversationMenu
          ref={menuRef}
          onDelete={onDelete}
          onRename={() => setRenaming(true)}
          onMove={() => setMoving(true)}
          triggerClassName='hidden group-hover:flex'
          compact
        />
      </div>
    </>
  )
}

function NavItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`
        w-full text-left px-3 py-2 text-sm rounded-lg flex items-center gap-2.5
        ${active ? 'text-text-primary bg-selected' : 'text-text-secondary hover:text-text-primary hover:bg-surface2'}
        transition-colors
      `}
    >
      {icon}
      {label}
    </button>
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
