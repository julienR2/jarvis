import { useState, useEffect, useMemo, useRef } from 'react'
import { Plus, Trash2, Search, X, ExternalLink, Loader2 } from 'lucide-react'
import { api, type OneStatus, type OneConnection, type OnePlatform } from '../api'
import { Switch } from './RoutineCard'

/**
 * Settings › Customize › One: apps connected through One (withone.ai).
 *
 * The counterpart of the Connectors tab for apps whose credentials stay at
 * One: the person signs in on One's site, and Jarvis acts through One's MCP
 * server. A separate tab while it is an experiment — the key can be removed
 * (or One switched off) without touching the connectors Jarvis holds itself.
 */

const ONE_APP_URL = 'https://app.withone.ai'

/** One's dashboard opens the connect card for a platform from the hash — the page `one add` opens. */
function connectUrl(platform: string, env: 'test' | 'live' | null): string {
  return `${ONE_APP_URL}/?env=${env ?? 'live'}#open=${encodeURIComponent(platform)}`
}

/** How long to wait for a sign-in started in the other tab before giving up. */
const CONNECT_TIMEOUT = 5 * 60 * 1000

export default function OnePanel() {
  const [status, setStatus] = useState<OneStatus | null>(null)

  async function loadStatus() {
    setStatus(await api.getOneStatus())
  }
  useEffect(() => { loadStatus() }, [])

  if (!status) return null

  return (
    <div>
      <h2 className='text-xs font-medium text-text-muted uppercase tracking-wide mb-2'>One</h2>
      <p className='text-text-muted text-sm mb-4'>
        Connect apps — Gmail, Calendar, Spotify, Notion and about a thousand more — through{' '}
        <a href='https://www.withone.ai' target='_blank' rel='noreferrer' className='text-accent hover:underline'>One</a>.
        You sign in on One's site; the credentials stay there, and Jarvis acts through One.
      </p>

      {status.configured
        ? <OneConnected status={status} onChange={loadStatus} />
        : (
          <div className='bg-surface border border-border rounded-xl px-4 py-4'>
            <OneKeyForm onSaved={loadStatus} />
            <p className='text-xs text-text-muted mt-3'>
              No key? Connectors can still be added by hand in the Connectors tab.
            </p>
          </div>
        )}
    </div>
  )
}

/** Paste and verify a One API key. Also offered from the Connectors tab. */
export function OneKeyForm({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    if (!key.trim()) return
    setError('')
    setSaving(true)
    try {
      await api.setOneKey(key.trim())
      setKey('')
      onSaved()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <label className='text-xs font-medium text-text-muted mb-1 block'>One API key</label>
      <div className='flex gap-2'>
        <input
          type='password'
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          placeholder='sk_live_…'
          autoComplete='off'
          className='flex-1 min-w-0 bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent focus:outline-none'
        />
        <button
          onClick={save}
          disabled={saving || !key.trim()}
          className='bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors'
        >
          {saving ? 'Checking…' : 'Save'}
        </button>
      </div>
      {error && <div className='text-danger text-xs mt-2'>{error}</div>}
      <p className='text-[11px] text-text-muted mt-2'>
        Create one at{' '}
        <a href={`${ONE_APP_URL}/settings/api-keys`} target='_blank' rel='noreferrer' className='text-accent hover:underline'>
          app.withone.ai/settings/api-keys
        </a>
        . It is checked against One before it is saved.
      </p>
    </div>
  )
}

function OneConnected({ status, onChange }: { status: OneStatus; onChange: () => void }) {
  const [connections, setConnections] = useState<OneConnection[] | null>(null)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  // A sign-in under way in another tab: which platform, and what existed before.
  const [pending, setPending] = useState<{ platform: string; name: string; before: Set<string>; since: number } | null>(null)

  async function load(): Promise<OneConnection[] | null> {
    try {
      const rows = await api.getOneConnections()
      setConnections(rows)
      setError('')
      return rows
    } catch (err: any) {
      setError(err.message)
      return null
    }
  }
  useEffect(() => { load() }, [])

  // Poll while a sign-in is pending, and check at once when the tab regains focus.
  useEffect(() => {
    if (!pending) return
    let stopped = false
    async function check() {
      const rows = await load()
      if (stopped || !rows || !pending) return
      const made = rows.find((c) => c.platform === pending.platform && !pending.before.has(c.id))
      if (made) {
        setPending(null)
        window.__jarvisToast?.success(`${made.name} connected — Jarvis can use it from the next message.`)
      } else if (Date.now() - pending.since > CONNECT_TIMEOUT) {
        setPending(null)
      }
    }
    const timer = setInterval(check, 4000)
    window.addEventListener('focus', check)
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('focus', check) }
  }, [pending])

  function connect(p: OnePlatform) {
    // Opened synchronously, inside the click: after an await, browsers block it.
    window.open(connectUrl(p.platform, status.environment), '_blank', 'noopener')
    setPicking(false)
    setPending({
      platform: p.platform,
      name: p.name,
      before: new Set((connections ?? []).map((c) => c.id)),
      since: Date.now(),
    })
  }

  async function remove(c: OneConnection) {
    if (!confirm(`Disconnect ${c.name}${c.identity ? ` (${c.identity})` : ''} from One? This revokes it on One for every agent, not just Jarvis.`)) return
    try {
      await api.deleteOneConnection(c.id)
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function toggle() {
    await api.setOneEnabled(!status.enabled)
    onChange()
  }

  async function unplug() {
    if (!confirm('Remove the One key? Jarvis stops seeing these apps; they stay connected in your One account.')) return
    await api.clearOneKey()
    onChange()
  }

  return (
    <div className='flex flex-col gap-4'>
      <div className='bg-surface border border-border rounded-xl px-4 py-3 flex items-center gap-3'>
        <div className='flex-1 min-w-0'>
          <div className='text-sm text-text-primary'>Available to Jarvis</div>
          <div className='text-xs text-text-muted truncate'>
            Key {status.keyHint} · {status.environment === 'test' ? 'Sandbox' : 'Live'}
          </div>
        </div>
        <Switch on={status.enabled} label='Available to Jarvis' onClick={toggle} />
        <button
          onClick={unplug}
          className='text-xs px-2 py-1.5 rounded-lg text-danger hover:bg-surface2 transition-colors'
          title='Remove the One key'
        >
          Remove key
        </button>
      </div>

      {error && <div className='text-danger text-xs'>{error}</div>}

      {pending && (
        <div className='bg-surface border border-accent/40 rounded-xl px-4 py-3 flex items-center gap-3 text-sm'>
          <Loader2 size={16} className='animate-spin text-accent shrink-0' />
          <span className='flex-1 text-text-secondary'>
            Finish signing in to {pending.name} in the tab that opened…
          </span>
          <a
            href={connectUrl(pending.platform, status.environment)}
            target='_blank'
            rel='noreferrer'
            className='text-xs text-accent hover:underline flex items-center gap-1'
          >
            Reopen <ExternalLink size={12} />
          </a>
          <button onClick={() => setPending(null)} className='text-text-muted hover:text-text-primary' title='Stop waiting'>
            <X size={14} />
          </button>
        </div>
      )}

      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        {connections?.map((c) => <OneConnectionCard key={c.id} connection={c} onDelete={() => remove(c)} />)}
        <button
          onClick={() => setPicking(true)}
          className='border border-dashed border-border rounded-xl px-4 py-4 flex items-center gap-3 text-text-muted hover:text-text-primary hover:border-accent/40 hover:bg-surface transition-colors'
        >
          <div className='w-10 h-10 rounded-lg bg-surface2 flex items-center justify-center'>
            <Plus size={20} />
          </div>
          <div className='text-left'>
            <div className='text-sm font-medium'>Connect an app</div>
            <div className='text-xs opacity-70'>Pick it, then sign in on One</div>
          </div>
        </button>
      </div>

      {picking && <PlatformPicker onPick={connect} onClose={() => setPicking(false)} />}
    </div>
  )
}

const STATE_LABEL: Record<OneConnection['state'], string | null> = {
  operational: null,
  unknown: null,
  degraded: 'Degraded',
  failed: 'Needs reconnecting',
}

function OneConnectionCard({ connection: c, onDelete }: { connection: OneConnection; onDelete: () => void }) {
  const badge = STATE_LABEL[c.state]
  return (
    <div className='bg-surface border border-border rounded-xl px-4 py-4 flex items-start gap-3'>
      <div className='w-10 h-10 rounded-lg bg-surface2 flex items-center justify-center shrink-0 overflow-hidden p-1.5'>
        {c.image && <img src={c.image} alt='' className='w-full h-full object-contain' />}
      </div>
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-2'>
          <span className='font-medium text-sm text-text-primary truncate'>{c.name}</span>
          <span className='text-[10px] text-text-muted bg-surface2 px-1.5 py-0.5 rounded font-medium'>One</span>
          {badge && <span className='text-[10px] text-danger bg-surface2 px-1.5 py-0.5 rounded font-medium'>{badge}</span>}
        </div>
        <p className='text-xs text-text-muted mt-0.5 truncate'>{c.identity || c.platform}</p>
      </div>
      <button
        onClick={onDelete}
        className='text-xs px-2 py-1.5 rounded-lg text-danger hover:bg-surface2 transition-colors'
        title='Disconnect'
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

/** The rendered list is capped: a thousand logos at once is a slow first paint for nothing. */
const PICKER_LIMIT = 60

function PlatformPicker({ onPick, onClose }: { onPick: (p: OnePlatform) => void; onClose: () => void }) {
  const [catalog, setCatalog] = useState<OnePlatform[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.getOneCatalog().then(setCatalog, (err) => setError(err.message))
    inputRef.current?.focus()
  }, [])

  const matches = useMemo(() => {
    if (!catalog) return []
    const q = query.trim().toLowerCase()
    const hits = q
      ? catalog.filter((p) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))
      : catalog
    // Names that start with the query first, then by name.
    return [...hits]
      .sort((a, b) =>
        Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q))
        || a.name.localeCompare(b.name))
      .slice(0, PICKER_LIMIT)
  }, [catalog, query])

  return (
    <div className='fixed inset-0 z-[200] flex items-center justify-center bg-black/40' onClick={onClose}>
      <div
        className='bg-surface border border-border rounded-xl p-5 w-full max-w-lg shadow-lg mx-4 h-[75vh] flex flex-col'
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className='font-medium text-text-primary mb-3'>Connect an app</h3>
        <div className='relative mb-3'>
          <Search size={14} className='absolute left-3 top-1/2 -translate-y-1/2 text-text-muted' />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
            placeholder={catalog ? `Search ${catalog.length} apps…` : 'Loading apps…'}
            className='w-full bg-surface2 border border-border text-text-primary rounded-lg pl-8 pr-3 py-2 text-sm focus:border-accent focus:outline-none'
          />
        </div>
        {error && <div className='text-danger text-xs mb-2'>{error}</div>}
        <div className='flex-1 overflow-y-auto -mx-2'>
          {matches.map((p) => (
            <button
              key={p.platform}
              onClick={() => onPick(p)}
              className='w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface2 text-left transition-colors'
            >
              <div className='w-8 h-8 rounded-lg bg-surface2 flex items-center justify-center shrink-0 overflow-hidden p-1'>
                {p.image && <img src={p.image} alt='' loading='lazy' className='w-full h-full object-contain' />}
              </div>
              <div className='flex-1 min-w-0'>
                <div className='text-sm text-text-primary truncate'>
                  {p.name}
                  {p.status !== 'generally_available' && (
                    <span className='ml-2 text-[10px] text-text-muted bg-surface2 px-1.5 py-0.5 rounded'>{p.status}</span>
                  )}
                </div>
                <div className='text-xs text-text-muted truncate'>{p.category}</div>
              </div>
            </button>
          ))}
          {catalog && matches.length === 0 && (
            <div className='text-sm text-text-muted px-2 py-4'>No app matches “{query}”.</div>
          )}
        </div>
      </div>
    </div>
  )
}
