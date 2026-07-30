import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Plus,
  Clock,
  Code2,
  Plug,
  LogOut,
  Moon,
  Sun,
  Monitor,
  BellOff,
  AppWindow,
  Home,
  Link2,
  RefreshCw,
  BellRing,
  ChevronUp,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderPlus,
  Settings,
} from 'lucide-react'
import { useTheme } from '../hooks/useTheme'
import { useNotifications } from '../hooks/useNotifications'
import { useLongPress } from '../hooks/useLongPress'
import ConversationMenu, {
  type ConversationMenuHandle,
} from './ConversationMenu'
import NameModal from './NameModal'
import SectionPicker from './SectionPicker'
import type { Conversation, Section } from '../api'
import { useChatStore } from '../stores/chatStore'
import { useShallow } from 'zustand/react/shallow'

interface Props {
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onMove: (id: string, sectionId: string | null) => void
  onSelect: () => void
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

  const onToolsPage =
    location.pathname === '/crons' ||
    location.pathname === '/webhooks' ||
    location.pathname === '/connectors' ||
    location.pathname.startsWith('/code')

  function logout() {
    localStorage.removeItem('token')
    navigate('/login')
  }

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
    <aside className='w-64 bg-bg-alt flex flex-col h-full shrink-0 border-r border-border safe-area-insets'>
      {/* Header */}
      <div className='px-3 pt-4 pb-2 space-y-0.5'>
        <button
          onClick={() => handleNav('/')}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${location.pathname === '/' ? 'text-text-primary bg-selected' : 'text-text-secondary hover:bg-surface2'}`}
        >
          <Home size={16} />
          <span>Home</span>
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
          <span>New section</span>
        </button>
        {creatingSection && (
          <NameModal
            title='New section'
            placeholder='Apps, Crons, Work…'
            confirmLabel='Create'
            onSubmit={(name) => createSection(name)}
            onClose={() => setCreatingSection(false)}
          />
        )}
      </div>

      {/* Scrollable list */}
      <div className='flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-4'>
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

      {/* Bottom nav — one row: everything rarely used lives behind Settings. */}
      <div className='border-t border-border p-2'>
        <div className='flex items-center gap-1'>
          <SettingsMenu
            onToolsPage={onToolsPage}
            activePath={location.pathname}
            onNav={handleNav}
            onLogout={logout}
          />
          <button
            onClick={async () => {
              const keys = await caches.keys()
              await Promise.all(keys.map((k) => caches.delete(k)))
              const reg = await navigator.serviceWorker?.getRegistration()
              if (reg) {
                await reg.unregister()
              }
              window.location.reload()
            }}
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
 * Everything below the chat list, behind one row. Crons/webhooks/connectors/code
 * and logout are rare enough that a permanent five-row block wasn't earning its
 * space. Opens upward, since it sits at the bottom of the sidebar.
 */
function SettingsMenu({
  onToolsPage,
  activePath,
  onNav,
  onLogout,
}: {
  onToolsPage: boolean
  activePath: string
  onNav: (path: string) => void
  onLogout: () => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleOutside(e: MouseEvent | TouchEvent) {
      if (containerRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('click', handleOutside)
    window.addEventListener('touchstart', handleOutside)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('click', handleOutside)
      window.removeEventListener('touchstart', handleOutside)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open])

  function go(path: string) {
    setOpen(false)
    onNav(path)
  }

  return (
    <div ref={containerRef} className='relative flex-1'>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors ${
          onToolsPage
            ? 'text-text-primary bg-selected'
            : open
              ? 'text-text-primary bg-surface2'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface2'
        }`}
      >
        <Settings size={15} />
        <span className='flex-1 text-left'>Settings</span>
      </button>
      {open && (
        <div className='absolute bottom-full left-0 mb-1 z-[200] w-[calc(100%+0.5rem)] min-w-[170px] bg-surface border border-border rounded-xl shadow-lg p-1'>
          <NavItem
            label='Crons'
            icon={<Clock size={15} />}
            active={activePath === '/crons'}
            onClick={() => go('/crons')}
          />
          <NavItem
            label='Webhooks'
            icon={<Link2 size={15} />}
            active={activePath === '/webhooks'}
            onClick={() => go('/webhooks')}
          />
          <NavItem
            label='Connectors'
            icon={<Plug size={15} />}
            active={activePath === '/connectors'}
            onClick={() => go('/connectors')}
          />
          <NavItem
            label='Code'
            icon={<Code2 size={15} />}
            active={activePath.startsWith('/code')}
            onClick={() => go('/code')}
          />
          <div className='h-px bg-border my-1' />
          <NavItem
            label='Logout'
            icon={<LogOut size={15} />}
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * One collapsible sidebar group. `section` is null for the default "Chats" group,
 * which can't be renamed, moved, or deleted.
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

  const unread = convs.reduce((n, c) => n + (c.unread_count || 0), 0)
  // Collapsed groups still show the open conversation, so navigating into one
  // never makes it disappear.
  const visible = collapsed
    ? convs.filter((c) => activePath === `/c/${c.id}`)
    : convs

  return (
    <div className='gap-0.5 flex flex-col mt-1'>
      <div className='flex items-center group/section pr-1'>
        <button
          onClick={onToggle}
          className='flex-1 flex items-center px-3 py-1 min-w-0 text-[11px] font-semibold text-text-muted uppercase tracking-wider hover:text-text-secondary transition-colors'
        >
          <span className='truncate'>{section ? section.name : 'Chats'}</span>
        </button>
        {/* With no chevron, a collapsed group would look identical to an empty
            one — the badge is what says "there's something folded in here". */}
        {collapsed && unread > 0 && (
          <span className='shrink-0 min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-accent text-white text-[11px] font-medium'>
            {unread}
          </span>
        )}
        {collapsed && unread === 0 && convs.length > 0 && (
          <span className='shrink-0 px-1.5 text-[11px] font-medium text-text-muted/70'>
            {convs.length}
          </span>
        )}
        {section && (
          <SectionMenu
            canMoveUp={canMoveUp}
            canMoveDown={canMoveDown}
            onRename={() => setRenaming(true)}
            onMoveUp={() => moveSection(section.id, -1)}
            onMoveDown={() => moveSection(section.id, 1)}
            onDelete={() => {
              if (
                confirm(
                  `Delete the "${section.name}" section? Its chats move back to Chats.`,
                )
              )
                deleteSection(section.id)
            }}
          />
        )}
      </div>
      {renaming && section && (
        <NameModal
          title='Rename section'
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
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  canMoveUp: boolean
  canMoveDown: boolean
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
        title='Section options'
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
              onClick={(e) => { e.stopPropagation(); navigate(`/crons?conversation_id=${conv.id}`) }}
            >
              <Clock size={11} className='text-text-muted hover:text-accent' />
            </span>
          )}
          {!!conv.has_webhook && (
            <span
              title='Webhook'
              className='hover:text-accent transition-colors cursor-pointer'
              onClick={(e) => { e.stopPropagation(); navigate(`/webhooks?conversation_id=${conv.id}`) }}
            >
              <Link2 size={11} className='text-text-muted hover:text-accent' />
            </span>
          )}
          {conv.notify === 'unsubscribe' && (
            <span title='Notifications off'>
              <BellOff size={11} className='text-text-muted' />
            </span>
          )}
          {conv.notify === 'auto' && (
            <span title='Auto notifications'>
              <BellRing size={11} className='text-text-muted' />
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
