import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { api } from '../api'
import type { DeleteOptions } from '../api'

interface Props {
  /** Known when the menu belongs to one chat; what it holds is fetched from it. */
  conversationId?: string
  onConfirm: (opts: DeleteOptions) => void
  onClose: () => void
}

type Footprint = { uploads: number; app: boolean; routines: number }

/**
 * The delete confirm. It asks only about what the chat actually has: a chat
 * with no files and no routines is just "Delete it?". Where there is something,
 * the switch starts off, which is the recoverable path — files are archived,
 * routines keep running and open a new chat on their next fire. Switching one
 * on makes that part permanent.
 */
export default function DeleteConversationDialog({ conversationId, onConfirm, onClose }: Props) {
  const [files, setFiles] = useState(false)
  const [routines, setRoutines] = useState(false)
  // null while looking; without an id there is nothing to look up.
  const [footprint, setFootprint] = useState<Footprint | null>(
    conversationId ? null : { uploads: 0, app: false, routines: 0 },
  )

  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    api
      .getConversationFootprint(conversationId)
      // Unknown is treated as "there may be files": asking is the safe side.
      .catch(() => ({ uploads: 1, app: false, routines: 0 }))
      .then((f) => { if (!cancelled) setFootprint(f) })
    return () => { cancelled = true }
  }, [conversationId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const hasFiles = !!footprint && (footprint.uploads > 0 || footprint.app)
  const hasRoutines = !!footprint && footprint.routines > 0
  const what = footprint
    ? [
        footprint.uploads > 0 && `${footprint.uploads} file${footprint.uploads > 1 ? 's' : ''}`,
        footprint.app && 'its app',
      ].filter(Boolean).join(' and ')
    : ''

  return createPortal(
    <div
      className='fixed inset-0 z-[500] flex items-center justify-center bg-black/50 p-4'
      onClick={onClose}
      role='dialog'
      aria-labelledby='delete-conversation-title'
    >
      <div
        className='w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-xl'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='mb-1 flex items-center'>
          <h2 id='delete-conversation-title' className='flex-1 text-base font-semibold text-text-primary'>
            Delete this chat?
          </h2>
          <button onClick={onClose} className='p-1 text-text-muted hover:text-text-primary' aria-label='Close'>
            <X size={16} />
          </button>
        </div>
        <p className='text-sm text-text-muted'>Its messages are deleted. This can't be undone.</p>

        {footprint === null ? (
          <div className='flex justify-center py-4 text-text-muted'>
            <Loader2 size={16} className='animate-spin' />
          </div>
        ) : (hasFiles || hasRoutines) && (
          <div className='mt-4 divide-y divide-border rounded-xl border border-border'>
            {hasFiles && (
              <Toggle
                checked={files}
                onChange={setFiles}
                label={`Also delete ${what}`}
                hint={files ? 'Removed for good.' : 'Otherwise archived — recoverable from the files.'}
              />
            )}
            {hasRoutines && (
              <Toggle
                checked={routines}
                onChange={setRoutines}
                label={`Also delete its ${footprint.routines === 1 ? 'routine' : `${footprint.routines} routines`}`}
                hint={routines ? 'They stop for good.' : 'Otherwise they keep running and open a new chat.'}
              />
            )}
          </div>
        )}

        <div className='mt-5 flex justify-end gap-2'>
          <button
            onClick={onClose}
            className='rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text-primary transition-colors hover:border-accent'
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm({ files, routines })}
            disabled={footprint === null}
            className='rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50'
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Toggle({ checked, onChange, label, hint }: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  return (
    <label className='flex cursor-pointer items-center justify-between gap-4 px-3.5 py-3'>
      <span className='flex min-w-0 flex-col gap-0.5'>
        <span className='text-sm text-text-primary'>{label}</span>
        <span className='text-xs text-text-muted'>{hint}</span>
      </span>
      <button
        type='button'
        role='switch'
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-danger' : 'bg-border'}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  )
}
