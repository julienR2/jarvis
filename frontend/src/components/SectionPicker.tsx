import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, FolderPlus } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '../stores/chatStore'
import NameModal from './NameModal'

interface Props {
  /** Section the conversation currently sits in — null is the default group. */
  currentId: string | null
  onPick: (sectionId: string | null) => void
  onClose: () => void
}

/**
 * "Move to section" picker. A centered modal rather than a nested dropdown: the
 * sidebar is only 256px wide, and the same component then works for the chat
 * header and for long-press on mobile.
 */
export default function SectionPicker({ currentId, onPick, onClose }: Props) {
  const sections = useChatStore(useShallow((s) => s.sections))
  const createSection = useChatStore((s) => s.createSection)
  const [creating, setCreating] = useState(false)

  async function createAndPick(name: string) {
    const section = await createSection(name)
    if (section) onPick(section.id)
    onClose()
  }

  if (creating) {
    return (
      <NameModal
        title='New section'
        placeholder='Apps, Crons, Work…'
        confirmLabel='Create'
        onSubmit={createAndPick}
        onClose={onClose}
      />
    )
  }

  function pick(id: string | null) {
    if (id !== currentId) onPick(id)
    onClose()
  }

  return createPortal(
    <div
      className='fixed inset-0 z-[300] flex items-center justify-center bg-black/40'
      onClick={onClose}
    >
      <div
        className='bg-surface border border-border rounded-xl p-2 w-72 shadow-lg max-h-[70vh] flex flex-col'
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className='text-sm font-medium text-text-primary px-2 py-2'>
          Move to section
        </h3>
        <div className='flex-1 overflow-y-auto'>
          {sections.map((section) => (
            <Row
              key={section.id}
              label={section.name}
              selected={currentId === section.id}
              onClick={() => pick(section.id)}
            />
          ))}
          <Row
            label='Chats'
            selected={currentId === null}
            onClick={() => pick(null)}
          />
        </div>
        <div className='h-px bg-border my-1' />
        <button
          onClick={() => setCreating(true)}
          className='w-full flex items-center gap-2.5 px-2 py-2 text-sm text-text-secondary hover:bg-surface2 hover:text-text-primary rounded-lg transition-colors'
        >
          <FolderPlus size={14} />
          New section…
        </button>
      </div>
    </div>,
    document.body,
  )
}

/**
 * No leading icon slot: section names carry their own emoji, so a slot would
 * push them out of line with the plain rows. Every label starts flush left.
 */
function Row({
  label,
  selected,
  onClick,
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2 py-2 text-sm rounded-lg transition-colors ${
        selected
          ? 'text-text-primary bg-selected'
          : 'text-text-secondary hover:bg-surface2 hover:text-text-primary'
      }`}
    >
      <span className='flex-1 text-left truncate'>{label}</span>
      {selected && <Check size={14} className='text-accent shrink-0' />}
    </button>
  )
}
