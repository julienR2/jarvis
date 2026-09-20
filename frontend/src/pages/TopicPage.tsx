import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AppWindow, Check, Clock, Link2, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, Repeat, Settings2, Sparkles, Trash2, X, Zap,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { SidebarToggle } from '../components/ContentLayout'
import { Markdown } from '../components/MessageBubble'
import NeedsYouCard from '../components/NeedsYouCard'
import NameModal from '../components/NameModal'
import { api, pendingQuestionOf, type Conversation } from '../api'
import type { Routine } from '../components/RoutineForm'
import { useChatStore } from '../stores/chatStore'
import { describeSchedule, relative } from '../lib/runs'

/**
 * A topic, opened as a page.
 *
 * A topic is a section that carries a brief — what this is about, what was
 * decided, what is open, how to work here. Every chat filed under it starts
 * from that brief, and every routine posting into one of its chats runs with
 * it: the context is built once and shared, instead of re-explained at the top
 * of each new conversation.
 *
 * The page is the brief first — readable, editable in place, and refreshable
 * by Jarvis from the topic's own chats — then what waits on you here, the
 * routines that run here, and the chats. Not a log: the only live rows are
 * the ones asking something.
 */
export default function TopicPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const section = useChatStore((s) => s.sections.find((x) => x.id === id))
  const sectionsLoaded = useChatStore((s) => s.sections.length > 0 || s.listLoaded)
  const conversations = useChatStore(
    useShallow((s) => s.order.map((cid) => s.conversations[cid]).filter((c): c is Conversation => !!c && c.section_id === id)),
  )
  const [routines, setRoutines] = useState<Routine[] | null>(null)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [creating, setCreating] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const convIds = useMemo(() => new Set(conversations.map((c) => c.id)), [conversations])
  const loadRoutines = useCallback(async () => {
    try {
      const [crons, hooks] = await Promise.all([api.getCrons(), api.getWebhooks()])
      const mine: Routine[] = [
        ...crons.filter((c) => c.conversation_id && convIds.has(c.conversation_id)).map((row): Routine => ({ kind: 'cron', row })),
        ...hooks.filter((h) => h.conversation_id && convIds.has(h.conversation_id)).map((row): Routine => ({ kind: 'webhook', row })),
      ]
      mine.sort((a, b) => a.row.name.localeCompare(b.row.name))
      setRoutines(mine)
    } catch {
      setRoutines([])
    }
  }, [convIds])
  useEffect(() => { loadRoutines() }, [loadRoutines])

  useEffect(() => {
    if (!menu) return
    const onOutside = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false) }
    window.addEventListener('click', onOutside)
    return () => window.removeEventListener('click', onOutside)
  }, [menu])

  const waiting = conversations.filter((c) => !!pendingQuestionOf(c))

  async function newChatHere() {
    if (!section || creating) return
    setCreating(true)
    try {
      const conv = await useChatStore.getState().createConversation()
      await useChatStore.getState().patchConversation(conv.id, { section_id: section.id })
      navigate(`/c/${conv.id}`)
    } finally {
      setCreating(false)
    }
  }

  async function toggleRoutine(r: Routine) {
    if (r.kind === 'cron') await api.updateCron(r.row.id, { enabled: !r.row.enabled })
    else await api.updateWebhook(r.row.id, { enabled: !r.row.enabled })
    await loadRoutines()
  }
  async function fireRoutine(r: Routine) {
    if (r.kind === 'cron') await api.triggerCron(r.row.id)
    else await api.triggerWebhook(r.row.id)
    window.__jarvisToast?.info(`${r.row.name} is running.`)
  }

  if (!section) {
    return (
      <div className='flex h-full items-center justify-center text-sm text-text-muted'>
        {sectionsLoaded ? (
          <span>This topic no longer exists. <button onClick={() => navigate('/')} className='underline hover:text-text-primary'>Back to Today</button></span>
        ) : (
          <Loader2 size={16} className='animate-spin' />
        )}
      </div>
    )
  }

  return (
    <div className='flex flex-col h-full' data-testid='topic-page'>
      <div className='shrink-0 border-b border-border'>
        <div className='flex items-center gap-2 h-12 px-3 md:px-6'>
          <SidebarToggle />
          <h1 className='min-w-0 flex-1 truncate text-sm font-medium text-text-primary'>
            <span className='text-text-muted font-normal'>Topics / </span>{section.name}
          </h1>
          <button
            onClick={newChatHere}
            disabled={creating}
            className='inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-text-secondary hover:bg-surface2 hover:text-text-primary transition-colors disabled:opacity-50'
          >
            <Plus size={13} /> New chat here
          </button>
          <div ref={menuRef} className='relative'>
            <button onClick={() => setMenu((m) => !m)} title='Topic options' className={`rounded-lg p-1.5 text-text-muted hover:bg-surface2 hover:text-text-primary ${menu ? 'bg-surface2 text-text-primary' : ''}`}>
              <MoreHorizontal size={15} />
            </button>
            {menu && (
              <div onClick={(e) => e.stopPropagation()} className='absolute right-0 top-full mt-1 z-[200] min-w-[160px] rounded-xl border border-border bg-surface p-1 shadow-md/5'>
                <MenuItem icon={<Pencil size={14} />} label='Rename' onClick={() => { setMenu(false); setRenaming(true) }} />
                <MenuItem icon={<Repeat size={14} />} label='Routines' onClick={() => { setMenu(false); navigate(`/routines?section_id=${section.id}`) }} />
                <MenuItem
                  icon={<Trash2 size={14} />}
                  label='Delete topic'
                  danger
                  onClick={() => {
                    setMenu(false)
                    if (confirm(`Delete the topic "${section.name}"? Its chats move back to Chats; the brief is lost.`)) {
                      useChatStore.getState().deleteSection(section.id).then(() => navigate('/'))
                    }
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {renaming && (
        <NameModal
          title='Rename topic'
          initialValue={section.name}
          onSubmit={(name) => useChatStore.getState().renameSection(section.id, name)}
          onClose={() => setRenaming(false)}
        />
      )}

      <div className='flex-1 overflow-y-auto'>
        <div className='max-w-3xl mx-auto px-4 md:px-6 py-6 flex flex-col gap-7'>
          <Brief section={section} />

          {waiting.length > 0 && (
            <section data-testid='topic-waiting'>
              <Eyebrow>Needs you · {waiting.length}</Eyebrow>
              <div className='flex flex-col gap-3'>
                {waiting.map((c) => (
                  <NeedsYouCard key={c.id} conversation={c} onOpen={() => navigate(`/c/${c.id}`)} />
                ))}
              </div>
            </section>
          )}

          <section data-testid='topic-routines'>
            <div className='flex items-center justify-between mb-1'>
              <Eyebrow>Routines{routines && routines.length ? ` · ${routines.length}` : ''}</Eyebrow>
              <button
                onClick={() => navigate(`/routines?new=cron${conversations[0] ? `&conversation_id=${conversations[0].id}` : ''}`)}
                className='inline-flex items-center gap-1 text-[11.5px] text-text-muted hover:text-text-primary transition-colors'
              >
                <Plus size={11} /> New routine
              </button>
            </div>
            {routines === null ? (
              <div className='flex items-center gap-2 py-3 text-xs text-text-muted'><Loader2 size={12} className='animate-spin' /> Loading…</div>
            ) : routines.length === 0 ? (
              <p className='py-2 text-[12.5px] text-text-muted'>Nothing runs on its own here yet. A routine posts into one of this topic's chats, on a schedule or when called, and works with the brief.</p>
            ) : (
              <div className='divide-y divide-border'>
                {routines.map((r) => {
                  const Icon = r.kind === 'webhook' ? Link2 : Clock
                  const conv = r.row.conversation_id ? conversations.find((c) => c.id === r.row.conversation_id) : undefined
                  return (
                    <div key={`${r.kind}-${r.row.id}`} className={`flex items-center gap-3 py-2.5 ${r.row.enabled ? '' : 'opacity-60'}`} data-testid='topic-routine'>
                      <Icon size={13} className='shrink-0 text-text-muted' />
                      <div className='min-w-0 flex-1'>
                        <div className='flex flex-wrap items-baseline gap-x-2'>
                          <span className='text-[13.5px] font-medium text-text-primary'>{r.row.name}</span>
                          <span className='text-[12px] text-text-secondary'>{r.kind === 'cron' ? describeSchedule(r.row.schedule) : 'when called'}</span>
                        </div>
                        <div className='text-[11.5px] text-text-muted'>
                          {conv && <button onClick={() => navigate(`/c/${conv.id}`)} className='hover:text-text-primary'>{conv.title}</button>}
                          {conv && ' · '}
                          {r.row.last_run ? `last ${relative(r.row.last_run)}` : 'never ran'}
                        </div>
                      </div>
                      <button
                        role='switch'
                        aria-checked={!!r.row.enabled}
                        aria-label={`${r.row.enabled ? 'Pause' : 'Resume'} ${r.row.name}`}
                        onClick={() => toggleRoutine(r)}
                        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${r.row.enabled ? 'bg-success' : 'bg-border'}`}
                      >
                        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${r.row.enabled ? 'left-[14px]' : 'left-0.5'}`} />
                      </button>
                      <button onClick={() => fireRoutine(r)} title='Run now' className='rounded-md p-1 text-text-muted/60 hover:bg-surface2 hover:text-accent'><Zap size={13} /></button>
                      <button onClick={() => navigate(`/routines?edit=${r.row.id}`)} title='Edit this routine' className='rounded-md p-1 text-text-muted/60 hover:bg-surface2 hover:text-text-primary'><Settings2 size={13} /></button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section data-testid='topic-chats'>
            <Eyebrow>Chats{conversations.length ? ` · ${conversations.length}` : ''}</Eyebrow>
            {conversations.length === 0 ? (
              <p className='py-2 text-[12.5px] text-text-muted'>No chat here yet. Start one — it opens with the brief already in mind.</p>
            ) : (
              <div className='divide-y divide-border'>
                {conversations.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => navigate(`/c/${c.id}`)}
                    className='flex w-full items-center gap-3 py-2.5 text-left hover:bg-surface2/60 -mx-2 px-2 rounded-lg transition-colors'
                    data-testid='topic-chat'
                  >
                    <MessageSquare size={13} className='shrink-0 text-text-muted' />
                    <span className={`min-w-0 flex-1 truncate text-[13.5px] ${c.unread_count > 0 ? 'font-medium text-text-primary' : 'text-text-primary'}`}>{c.title}</span>
                    {!!c.app_path && <AppWindow size={12} className='shrink-0 text-text-muted' />}
                    {c.unread_count > 0 && (
                      <span className='shrink-0 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-accent text-white text-[10.5px] font-medium'>{c.unread_count}</span>
                    )}
                    <span className='shrink-0 text-[11.5px] text-text-muted'>{relative(c.updated_at)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

/**
 * The brief: read it, edit it in place, or hand it to Jarvis to rewrite from
 * the topic's chats. The consolidation runs as an ordinary turn in the topic's
 * dossier chat, so it streams and can be stopped like anything else.
 */
function Brief({ section }: { section: { id: string; name: string; context: string; context_updated_at: number | null } }) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(section.context)
  const [saving, setSaving] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const updateSection = useChatStore((s) => s.updateSection)

  useEffect(() => { if (!editing) setDraft(section.context) }, [section.context, editing])

  async function save() {
    setSaving(true)
    try {
      await updateSection(section.id, { context: draft })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }
  async function consolidate() {
    setConsolidating(true)
    try {
      const { conversation_id } = await api.consolidateSection(section.id)
      await useChatStore.getState().loadConversations()
      navigate(`/c/${conversation_id}`)
    } catch {
      window.__jarvisToast?.error("Couldn't start the rewrite — try again.")
    } finally {
      setConsolidating(false)
    }
  }

  const empty = !section.context.trim()
  return (
    <section data-testid='topic-brief'>
      <div className='flex items-center justify-between mb-1'>
        <Eyebrow>
          Brief
          {section.context_updated_at && !empty && <span className='font-normal normal-case tracking-normal'> · updated {relative(section.context_updated_at)}</span>}
        </Eyebrow>
        {!editing && (
          <div className='flex items-center gap-2'>
            <button onClick={() => setEditing(true)} className='inline-flex items-center gap-1 text-[11.5px] text-text-muted hover:text-text-primary transition-colors' title='Edit the brief by hand'>
              <Pencil size={11} /> {empty ? 'Write' : 'Edit'}
            </button>
            <button onClick={consolidate} disabled={consolidating} className='inline-flex items-center gap-1 text-[11.5px] text-text-muted hover:text-text-primary transition-colors disabled:opacity-50' title="Jarvis rewrites the brief from this topic's chats">
              {consolidating ? <Loader2 size={11} className='animate-spin' /> : <Sparkles size={11} />} {empty ? 'Draft with Jarvis' : 'Refresh with Jarvis'}
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <div className='flex flex-col gap-2'>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(24, Math.max(8, draft.split('\n').length + 2))}
            placeholder={'**What this is** — two or three lines.\n\n**Decided**\n- …\n\n**Open**\n- …\n\n**How to work here**\n- the skills, connectors and conventions that apply'}
            aria-label='Brief'
            className='w-full resize-y rounded-xl border border-border bg-surface px-4 py-3 text-[13.5px] leading-relaxed text-text-primary font-mono focus:border-accent'
          />
          <div className='flex items-center justify-end gap-2 text-xs'>
            <span className='mr-auto text-text-muted'>{draft.length.toLocaleString()} characters · markdown</span>
            <button onClick={() => { setEditing(false); setDraft(section.context) }} className='inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-text-muted hover:text-text-primary'><X size={12} /> Cancel</button>
            <button onClick={save} disabled={saving} className='inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50'><Check size={12} /> Save</button>
          </div>
        </div>
      ) : empty ? (
        <div className='rounded-xl border border-dashed border-border px-4 py-5 text-center text-[13px] text-text-muted'>
          No brief yet. Write what this topic is about — every chat filed here will start from it — or let Jarvis draft one from the chats already here.
        </div>
      ) : (
        <div className='rounded-xl bg-bg-alt px-4 py-3 text-[14px] leading-relaxed text-text-primary'>
          <Markdown text={section.context} />
        </div>
      )}
    </section>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <h2 className='mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted'>{children}</h2>
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-2.5 px-2 py-1.5 text-sm rounded-lg hover:bg-surface2 transition-colors ${danger ? 'text-danger' : 'text-text-secondary'}`}>
      {icon}
      {label}
    </button>
  )
}
