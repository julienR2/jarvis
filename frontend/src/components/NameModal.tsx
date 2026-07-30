import { useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  title: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  onSubmit: (value: string) => void
  onClose: () => void
}

/**
 * Centered single-input modal — used for renaming a conversation and for
 * creating/renaming sidebar sections. Rendered in a portal so it escapes the
 * sidebar's overflow and stacking context.
 */
export default function NameModal({
  title,
  initialValue = '',
  placeholder,
  confirmLabel = 'Save',
  onSubmit,
  onClose,
}: Props) {
  const [value, setValue] = useState(initialValue)

  function submit() {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
    onClose()
  }

  return createPortal(
    <div
      className='fixed inset-0 z-[300] flex items-center justify-center bg-black/40'
      onClick={onClose}
    >
      <div
        className='bg-surface border border-border rounded-xl p-4 w-72 shadow-lg'
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className='text-sm font-medium text-text-primary mb-3'>{title}</h3>
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
          className='w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm text-text-primary focus:outline-none focus:border-accent'
        />
        <div className='flex justify-end gap-2 mt-3'>
          <button
            onClick={onClose}
            className='px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors'
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!value.trim()}
            className='px-3 py-1.5 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-40'
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
