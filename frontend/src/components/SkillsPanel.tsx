import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Loader2, MessageSquarePlus, Pencil, X } from 'lucide-react'
import { api, type SkillSummary } from '../api'
import { Markdown } from './MessageBubble'

/**
 * What Jarvis knows how to do, one row per skill. Jarvis picks the skill a
 * conversation needs by itself; here they are to read, to fix by hand, or to
 * hand to Jarvis — "Edit in chat" opens a new chat with the request started.
 */
export default function SkillsPanel() {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.getSkills().then(setSkills).catch(() => setSkills([]))
  }, [])

  function editInChat(name: string) {
    navigate('/', { state: { compose: Date.now(), draft: `I want to edit the "${name}" skill: ` } })
  }

  if (skills === null) {
    return <div className='flex justify-center py-8 text-text-muted'><Loader2 size={16} className='animate-spin' /></div>
  }

  const custom = skills.filter((s) => !s.builtin)
  const builtin = skills.filter((s) => s.builtin)

  return (
    <div className='flex flex-col gap-6'>
      <p className='text-sm text-text-muted'>
        Jarvis picks the skill a conversation needs by itself. Edits apply from the next message. To add a
        skill, ask Jarvis in a chat.
      </p>
      {custom.length > 0 && <Group title='Yours' skills={custom} onOpen={setOpen} onChat={editInChat} />}
      {builtin.length > 0 && <Group title='Built in' skills={builtin} onOpen={setOpen} onChat={editInChat} />}
      {open && <SkillReader name={open} onClose={() => setOpen(null)} onChat={() => { setOpen(null); editInChat(open) }} />}
    </div>
  )
}

function Group({ title, skills, onOpen, onChat }: {
  title: string
  skills: SkillSummary[]
  onOpen: (name: string) => void
  onChat: (name: string) => void
}) {
  return (
    <section>
      <h2 className='text-xs font-medium text-text-muted uppercase tracking-wide mb-2'>
        {title} <span className='normal-case tracking-normal font-normal'>· {skills.length}</span>
      </h2>
      <div className='rounded-2xl border border-border bg-surface divide-y divide-border'>
        {skills.map((s) => (
          <div key={s.name} className='group flex items-center gap-3 px-4 py-2.5' data-testid='skill-row'>
            <button onClick={() => onOpen(s.name)} className='min-w-0 flex-1 text-left'>
              <div className='text-sm text-text-primary truncate'>{s.name}</div>
              <div className='text-xs text-text-muted truncate'>{s.description || 'No description.'}</div>
            </button>
            <div className='flex shrink-0 items-center gap-1'>
              <IconButton label='Open' onClick={() => onOpen(s.name)}><Pencil size={13} /></IconButton>
              <IconButton label='Edit in chat' onClick={() => onChat(s.name)}><MessageSquarePlus size={13} /></IconButton>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className='rounded-lg p-1.5 text-text-muted hover:bg-surface2 hover:text-text-primary transition-colors'
    >
      {children}
    </button>
  )
}

/** Read a skill; Edit turns it into its raw SKILL.md, front matter included. */
function SkillReader({ name, onClose, onChat }: { name: string; onClose: () => void; onChat: () => void }) {
  const [skill, setSkill] = useState<{ content: string; raw: string } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getSkill(name).then(setSkill).catch(() => setError('Could not load this skill.'))
  }, [name])

  useEffect(() => {
    // Escape closes the reader, but never throws away an edit in progress.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && draft === null) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, draft])

  async function save() {
    if (draft === null) return
    setSaving(true)
    setError('')
    try {
      await api.saveSkill(name, draft)
      const fresh = await api.getSkill(name)
      setSkill(fresh)
      setDraft(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className='fixed inset-0 z-[500] bg-black/50 flex items-center justify-center p-4' onClick={draft === null ? onClose : undefined} role='dialog' aria-label={name}>
      <div
        className='bg-surface border border-border rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex items-center gap-2 px-5 pt-4 pb-3 border-b border-border'>
          <h2 className='text-base font-semibold text-text-primary flex-1 truncate'>{name}</h2>
          {draft === null ? (
            <>
              <SmallButton onClick={onChat} icon={<MessageSquarePlus size={13} />}>Edit in chat</SmallButton>
              <SmallButton onClick={() => skill && setDraft(skill.raw)} icon={<Pencil size={13} />} disabled={!skill}>Edit</SmallButton>
            </>
          ) : (
            <>
              <SmallButton onClick={() => { setDraft(null); setError('') }}>Cancel</SmallButton>
              <button
                onClick={save}
                disabled={saving || draft === skill?.raw}
                className='rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50'
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
          <button onClick={onClose} className='text-text-muted hover:text-text-primary p-1' aria-label='Close'>
            <X size={16} />
          </button>
        </div>
        {error && <div className='px-5 pt-3 text-xs text-danger'>{error}</div>}
        {draft !== null ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label='SKILL.md'
            className='m-4 min-h-[50vh] flex-1 resize-none rounded-xl border border-border bg-bg p-3 font-mono text-xs leading-relaxed text-text-primary outline-none focus:border-accent'
          />
        ) : (
          <div className='overflow-y-auto px-5 py-4'>
            {skill === null
              ? !error && <div className='flex justify-center py-6 text-text-muted'><Loader2 size={16} className='animate-spin' /></div>
              : <Markdown text={skill.content} className='text-sm' />}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function SmallButton({ onClick, icon, children, disabled }: { onClick: () => void; icon?: React.ReactNode; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className='inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 py-1 text-xs text-text-primary hover:border-accent transition-colors disabled:opacity-50'
    >
      {icon}
      {children}
    </button>
  )
}
