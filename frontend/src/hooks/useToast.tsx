import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastContextValue {
  show: (message: string, kind?: ToastKind) => void
  error: (message: string) => void
  success: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++
    setToasts((prev) => [...prev, { id, kind, message }])
    setTimeout(() => dismiss(id), 5000)
  }, [dismiss])

  const value: ToastContextValue = {
    show,
    error: (m) => show(m, 'error'),
    success: (m) => show(m, 'success'),
    info: (m) => show(m, 'info'),
  }

  // Expose a global hook so api.ts (non-React code) can push toasts too
  useEffect(() => {
    window.__jarvisToast = value
    return () => { delete window.__jarvisToast }
  }, [value])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className='fixed top-4 right-4 z-[1000] flex flex-col gap-2 pointer-events-none'>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const palette = {
    success: 'border-green-500/40 text-green-500',
    error: 'border-danger/40 text-danger',
    info: 'border-accent/40 text-accent',
  }[toast.kind]

  const Icon = { success: CheckCircle2, error: AlertCircle, info: Info }[toast.kind]

  return (
    <div
      role='status'
      className={`
        pointer-events-auto bg-surface border ${palette}
        rounded-lg shadow-lg px-3.5 py-2.5 max-w-sm flex items-start gap-2.5
        animate-fade-in
      `}
    >
      <Icon size={16} className='mt-0.5 shrink-0' />
      <p className='text-text-primary text-sm flex-1 break-words'>{toast.message}</p>
      <button
        onClick={onDismiss}
        className='text-text-muted hover:text-text-primary shrink-0'
        aria-label='Dismiss'
      >
        <X size={14} />
      </button>
    </div>
  )
}

declare global {
  interface Window {
    __jarvisToast?: ToastContextValue
  }
}
