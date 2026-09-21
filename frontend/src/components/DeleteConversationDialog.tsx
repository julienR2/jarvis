import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import type { DeleteOptions } from '../api'

interface Props {
  /** Known when the menu belongs to one chat; the routine count is fetched from it. */
  conversationId?: string
  onConfirm: (opts: DeleteOptions) => void
  onClose: () => void
}

/**
 * The delete confirm, with the two things that would otherwise be decided for
 * the person: what happens to the chat's files and to its routines. Both boxes
 * start unchecked, which is the recoverable path — files are archived, routines
 * keep running and open a new chat on their next fire. Ticking a box makes that
 * part permanent.
 */
export default function DeleteConversationDialog({ conversationId, onConfirm, onClose }: Props) {
  const [files, setFiles] = useState(false)
  const [routines, setRoutines] = useState(false)
  // null while counting; the routine line only appears when there is one.
  const [routineCount, setRoutineCount] = useState<number | null>(conversationId ? null : 0)

  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    Promise.all([api.getCrons(), api.getWebhooks()])
      .then(([crons, hooks]) => {
        if (cancelled) return
        setRoutineCount(
          crons.filter((c) => c.conversation_id === conversationId).length +
            hooks.filter((h) => h.conversation_id === conversationId).length,
        )
      })
      .catch(() => { if (!cancelled) setRoutineCount(0) })
    return () => { cancelled = true }
  }, [conversationId])

  return createPortal(
    <div
      className='fixed inset-0 z-[300] flex items-center justify-center bg-black/40 p-4'
      onClick={onClose}
      role='dialog'
      aria-labelledby='delete-conversation-title'
    >
      <div
        className='w-full max-w-sm rounded-xl border border-border bg-surface p-4 shadow-lg'
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id='delete-conversation-title' className='text-sm font-medium text-text-primary'>
          Delete this conversation?
        </h3>
        <p className='mt-1 text-xs text-text-muted'>Its messages go. The rest is up to you:</p>

        <div className='mt-3 flex flex-col gap-2.5'>
          <Option
            checked={files}
            onChange={setFiles}
            label='Also delete the files attached to this chat'
            hint={files ? 'Uploads and app removed for good.' : 'Otherwise they are archived, and can be recovered.'}
          />
          {!!routineCount && (
            <Option
              checked={routines}
              onChange={setRoutines}
              label={`Also delete its ${routineCount === 1 ? 'routine' : `${routineCount} routines`}`}
              hint={routines ? 'They stop for good.' : 'Otherwise they keep running and open a new chat.'}
            />
          )}
        </div>

        <div className='mt-4 flex justify-end gap-2'>
          <button
            onClick={onClose}
            className='px-3 py-1.5 text-sm text-text-secondary transition-colors hover:text-text-primary'
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm({ files, routines })}
            className='rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90'
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Option({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  return (
    <label className='flex cursor-pointer items-start gap-2.5'>
      <input
        type='checkbox'
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className='mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]'
      />
      <span className='flex flex-col gap-0.5 text-sm'>
        <span className='text-text-primary'>{label}</span>
        <span className='text-xs text-text-muted'>{hint}</span>
      </span>
    </label>
  )
}
