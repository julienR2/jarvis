import { createContext, useContext } from 'react'
import { Menu } from 'lucide-react'

interface SidebarContextValue {
  onToggle: () => void
  hasUnread: boolean
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

export const SidebarToggleProvider = SidebarContext.Provider

interface ContentLayoutProps {
  title?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function SidebarToggle() {
  const ctx = useContext(SidebarContext)
  if (!ctx) return null
  console.log('SidebarToggle render', ctx.hasUnread)
  return (
    <button
      onClick={ctx.onToggle}
      className='md:hidden relative shrink-0 p-1 rounded-lg text-text-muted hover:text-text-primary transition-colors'
    >
      <Menu size={18} />
      {ctx.hasUnread && (
        <span className='absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-accent' />
      )}
    </button>
  )
}

export function ContentTitle({
  children,
  action,
}: {
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className='shrink-0 border-b border-border'>
      <div className='flex items-center gap-2 h-12 px-3 md:px-6'>
        <SidebarToggle />
        <h1 className='text-sm font-medium text-text-primary truncate flex-1'>
          {children}
        </h1>
        {action}
      </div>
    </div>
  )
}

export default function ContentLayout({
  title,
  children,
  className,
}: ContentLayoutProps) {
  return (
    <div className='flex flex-col h-screen'>
      {title && <ContentTitle>{title}</ContentTitle>}
      <div className={`flex-1 overflow-y-auto ${className ?? ''}`}>
        <div className='max-w-3xl mx-auto px-4 md:px-6 py-6'>{children}</div>
      </div>
    </div>
  )
}
