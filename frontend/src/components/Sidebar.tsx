import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Plus,
  Clock,
  FolderOpen,
  LogOut,
  Moon,
  Sun,
  Monitor,
  BellOff,
  AppWindow,
  Home,
  Link2,
  MessageSquare,
  RefreshCw,
  BellRing,
  Layers,
} from 'lucide-react'
import { useTheme } from '../hooks/useTheme'
import { useNotifications } from '../hooks/useNotifications'
import { useLongPress } from '../hooks/useLongPress'
import ConversationMenu, {
  type ConversationMenuHandle,
} from './ConversationMenu'
import type { Conversation } from '../api'

interface Props {
  conversations: Conversation[]
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onSelect: () => void
}

export default function Sidebar({
  conversations,
  onNew,
  onDelete,
  onRename,
  onSelect,
}: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const { permission, requestPermission } = useNotifications()
  const { theme, preference, cycle } = useTheme()

  function logout() {
    localStorage.removeItem('token')
    navigate('/login')
  }

  function handleNav(path: string) {
    navigate(path, { replace: true })
    onSelect()
  }

  // Spaces: mini-apps, cron chats, and webhook chats grouped together
  const spaces = conversations.filter((c) => c.mini_app_path || c.has_cron || c.has_webhook)
  const regularConvs = conversations.filter((c) => !c.mini_app_path && !c.has_cron && !c.has_webhook)

  return (
    <aside className='w-64 bg-bg-alt flex flex-col h-full shrink-0 border-r border-border safe-area-insets'>
      {/* Header */}
      <div className='px-3 pt-4 pb-2 space-y-0.5'>
        <button
          onClick={() => handleNav('/')}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${location.pathname === '/' ? 'text-text-primary bg-surface2' : 'text-text-secondary hover:bg-surface2'}`}
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
      </div>

      {/* Scrollable list */}
      <div className='flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-6'>
        {conversations.length === 0 && (
          <div className='px-3 py-6 text-text-muted text-xs text-center'>
            No conversations yet
          </div>
        )}

        {/* Spaces section (mini-apps, cron chats, webhook chats) */}
        {spaces.length > 0 && (
          <div className='gap-0.5 flex flex-col mt-1'>
            <div className='flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold text-text-muted uppercase tracking-wider'>
              <Layers size={12} />
              Spaces
            </div>
            {spaces.map((conv) => (
              <ConvItem
                key={conv.id}
                conv={conv}
                active={location.pathname === `/c/${conv.id}`}
                onNav={() => handleNav(`/c/${conv.id}`)}
                onDelete={() => onDelete(conv.id)}
                onRename={(title) => onRename(conv.id, title)}
              />
            ))}
          </div>
        )}

        {/* Regular conversations */}
        <div className='gap-0.5 flex flex-col mt-1'>
          <div className='flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold text-text-muted uppercase tracking-wider'>
            <MessageSquare size={12} />
            Chats
          </div>
          {regularConvs.map((conv) => (
            <ConvItem
              key={conv.id}
              conv={conv}
              active={location.pathname === `/c/${conv.id}`}
              onNav={() => handleNav(`/c/${conv.id}`)}
              onDelete={() => onDelete(conv.id)}
              onRename={(title) => onRename(conv.id, title)}
            />
          ))}
        </div>
      </div>

      {/* Bottom nav */}
      <div className='border-t border-border p-2 space-y-0.5'>
        <NavItem
          label='Crons'
          icon={<Clock size={15} />}
          active={location.pathname === '/crons'}
          onClick={() => handleNav('/crons')}
        />
        <NavItem
          label='Webhooks'
          icon={<Link2 size={15} />}
          active={location.pathname === '/webhooks'}
          onClick={() => handleNav('/webhooks')}
        />
        <NavItem
          label='Files'
          icon={<FolderOpen size={15} />}
          active={location.pathname.startsWith('/files')}
          onClick={() => handleNav('/files')}
        />
        <div className='flex items-center gap-1'>
          <NavItem
            label='Logout'
            icon={<LogOut size={15} />}
            onClick={logout}
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
              <Sun size={15} />
            ) : (
              <Moon size={15} />
            )}
          </button>
        </div>
      </div>
    </aside>
  )
}

function ConvItem({
  conv,
  active,
  onNav,
  onDelete,
  onRename,
}: {
  conv: Conversation
  active: boolean
  onNav: () => void
  onDelete: () => void
  onRename: (title: string) => void
}) {
  const navigate = useNavigate()
  const menuRef = useRef<ConversationMenuHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const unread = conv.unread_count > 0 && !active
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const longPress = useLongPress(() => {
    menuRef.current?.open()
  })

  function startRename() {
    setRenameValue(conv.title)
    setRenaming(true)
  }

  function submitRename() {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== conv.title) onRename(trimmed)
    setRenaming(false)
  }

  return (
    <>
      {renaming && createPortal(
        <div
          className='fixed inset-0 z-[300] flex items-center justify-center bg-black/40'
          onClick={() => setRenaming(false)}
        >
          <div
            className='bg-surface border border-border rounded-xl p-4 w-72 shadow-lg'
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className='text-sm font-medium text-text-primary mb-3'>Edit name</h3>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename()
                if (e.key === 'Escape') setRenaming(false)
              }}
              className='w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm text-text-primary focus:outline-none focus:border-accent'
            />
            <div className='flex justify-end gap-2 mt-3'>
              <button
                onClick={() => setRenaming(false)}
                className='px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors'
              >
                Cancel
              </button>
              <button
                onClick={submitRename}
                className='px-3 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors'
              >
                Save
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      <div
        ref={containerRef}
        onClick={onNav}
        {...longPress}
        className={`
          relative flex items-center px-3 py-1.5 rounded-lg cursor-pointer group select-none transition-colors gap-2
          ${active ? 'bg-surface2 text-text-primary' : 'text-text-secondary hover:bg-surface2'}
        `}
      >
        <span
          className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm min-w-0 ${unread ? 'font-medium text-text-primary' : ''}`}
        >
          {conv.title}
        </span>
        <span className='flex items-center gap-2 shrink-0'>
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
          onRename={startRename}
          triggerClassName='hidden group-hover:flex'
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
        ${active ? 'text-text-primary bg-surface2' : 'text-text-secondary hover:text-text-primary hover:bg-surface2'}
        transition-colors
      `}
    >
      {icon}
      {label}
    </button>
  )
}
