import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import Select from './Select'
import {
  Mail,
  GitBranch,
  SquareKanban,
  Image,
  Database,
  Eye,
  EyeOff,
  Plug,
  X,
  Plus,
  Trash2,
  MessageSquare,
  HardDrive,
  AudioLines,
  Globe,
  Key,
  Cloud,
  Zap,
  Bot,
  type LucideIcon,
} from 'lucide-react'
import { api, type ConnectorInfo, type ConnectorDetail, type ConnectorInput, type OneStatus } from '../api'
import { OneKeyForm } from './OnePanel'

const ICON_MAP: Record<string, LucideIcon> = {
  Mail, Github: GitBranch, SquareKanban, Image, Database, MessageSquare,
  HardDrive, AudioLines, Globe, Key, Cloud, Zap, Bot, Plug,
}

const ICON_CHOICES = Object.keys(ICON_MAP)

function isImageUrl(icon: string): boolean {
  return /^(https?:\/\/|\/)/.test(icon)
}

function IconComponent({ name, size = 20 }: { name: string; size?: number }) {
  if (isImageUrl(name)) {
    return <img src={name} alt='' className='w-full h-full object-contain rounded' />
  }
  const Icon = ICON_MAP[name] ?? Plug
  return <Icon size={size} />
}

// A field row in the modal. `uid` is client-only: it lets the proxy settings
// point at a row before the row has a key.
type FieldRow = { uid: number; key?: string; label: string; value: string; type: 'text' | 'password' | 'email' }

let nextUid = 1
const blankRow = (): FieldRow => ({ uid: nextUid++, label: '', value: '', type: 'password' })

// The backend's key derivation (connectors.ts), so new rows get the key they
// will be saved under and the proxy can refer to them.
function assignKeys(rows: FieldRow[]): Map<number, string> {
  const taken = new Set(rows.filter((r) => r.key).map((r) => r.key!))
  const out = new Map<number, string>()
  for (const r of rows) {
    if (r.key) { out.set(r.uid, r.key); continue }
    let base = r.label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'FIELD'
    let key = base
    let n = 2
    while (taken.has(key)) key = `${base}_${n++}`
    taken.add(key)
    out.set(r.uid, key)
  }
  return out
}

type AuthMode = 'none' | 'header' | 'cookie'
interface ProxyForm {
  enabled: boolean
  baseUid: number | null
  auth: AuthMode
  headerName: string
  prefix: string
  cookieName: string
  valueUid: number | null
}

export default function ConnectorsPanel() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([])
  const [editing, setEditing] = useState<ConnectorDetail | null>(null)
  const [creating, setCreating] = useState(false)

  async function load() {
    setConnectors(await api.getConnectors())
  }

  useEffect(() => { load() }, [])

  async function startEdit(id: string) {
    setEditing(await api.getConnector(id))
  }

  async function remove(id: string) {
    await api.deleteConnector(id)
    load()
  }

  return (
    <div>
      <h2 className='text-xs font-medium text-text-muted uppercase tracking-wide mb-2'>
        Services
      </h2>
      <p className='text-text-muted text-sm mb-4'>
        Credentials for skills that need external services. Each connector is a
        set of named values Jarvis reads on demand.
      </p>

      <OneHint />

      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        {connectors.map((c) => (
          <ConnectorCard
            key={c.id}
            connector={c}
            onEdit={() => startEdit(c.id)}
            onDelete={() => remove(c.id)}
          />
        ))}
        <button
          onClick={() => setCreating(true)}
          className='border border-dashed border-border rounded-xl px-4 py-4 flex items-center gap-3 text-text-muted hover:text-text-primary hover:border-accent/40 hover:bg-surface transition-colors'
        >
          <div className='w-10 h-10 rounded-lg bg-surface2 flex items-center justify-center'>
            <Plus size={20} />
          </div>
          <div className='text-left'>
            <div className='text-sm font-medium'>Add connector</div>
            <div className='text-xs opacity-70'>Name it, then add label + value fields</div>
          </div>
        </button>
      </div>

      {(creating || editing) && (
        <ConnectorModal
          existing={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); load() }}
        />
      )}
    </div>
  )
}

// ── One ───────────────────────────────────────────────────────────────────────

/**
 * Points at the One tab: with a key, that apps can be connected there; without
 * one, offers to paste it right here instead of hand-writing a connector.
 */
function OneHint() {
  const [status, setStatus] = useState<OneStatus | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { api.getOneStatus().then(setStatus, () => {}) }, [])
  if (!status) return null

  if (status.configured) {
    return (
      <p className='text-xs text-text-muted mb-4'>
        Apps connected through One are in the{' '}
        <Link to='?tab=one' className='text-accent hover:underline'>One tab</Link>.
      </p>
    )
  }
  return (
    <div className='bg-surface border border-border rounded-xl px-4 py-3 mb-4'>
      <div className='flex items-center gap-3'>
        <p className='flex-1 text-xs text-text-muted'>
          Have a One key? Connect Gmail, Calendar, Spotify and more by signing in, instead of copying credentials.
        </p>
        {!open && (
          <button onClick={() => setOpen(true)} className='text-xs text-accent hover:text-accent-hover whitespace-nowrap'>
            Add key
          </button>
        )}
      </div>
      {open && (
        <div className='mt-3'>
          <OneKeyForm onSaved={() => api.getOneStatus().then(setStatus)} />
        </div>
      )}
    </div>
  )
}

// ── Connector card ──────────────────────────────────────────────────────────

function ConnectorCard({
  connector,
  onEdit,
  onDelete,
}: {
  connector: ConnectorInfo
  onEdit: () => void
  onDelete: () => void
}) {
  const fieldCount = connector.fields.length
  return (
    <div className='bg-surface border border-border rounded-xl px-4 py-4 flex flex-col gap-3'>
      <div className='flex items-start gap-3'>
        <div className='w-10 h-10 rounded-lg bg-surface2 flex items-center justify-center text-text-muted shrink-0 overflow-hidden'>
          <IconComponent name={connector.icon} />
        </div>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2'>
            <span className='font-medium text-sm text-text-primary truncate'>
              {connector.name}
            </span>
            {connector.proxy && (
              <span className='text-[10px] text-text-muted bg-surface2 px-1.5 py-0.5 rounded font-medium'>
                Proxy
              </span>
            )}
            {connector.hideValues && (
              <span
                className='text-[10px] text-text-muted bg-surface2 px-1.5 py-0.5 rounded font-medium'
                title='Jarvis never sees the secret values: it calls the service through the proxy.'
              >
                Hidden from Jarvis
              </span>
            )}
          </div>
          <p className='text-xs text-text-muted mt-0.5'>
            {connector.description || `${fieldCount} field${fieldCount === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      <div className='flex items-center gap-2'>
        <button
          onClick={onEdit}
          className='text-xs px-3 py-1.5 rounded-lg font-medium text-text-secondary hover:text-text-primary hover:bg-surface2 transition-colors'
        >
          Edit
        </button>
        <button
          onClick={onDelete}
          className='text-xs px-2 py-1.5 rounded-lg text-danger hover:bg-surface2 transition-colors'
          title='Delete connector'
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

// ── Add / edit modal ──────────────────────────────────────────────────────────

function ConnectorModal({
  existing,
  onClose,
  onSaved,
}: {
  existing: ConnectorDetail | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [icon, setIcon] = useState(existing?.icon ?? 'Plug')
  const [fields, setFields] = useState<FieldRow[]>(
    existing?.fields.length
      ? existing.fields.map((f) => ({ uid: nextUid++, key: f.key, label: f.label, value: f.value, type: f.type ?? 'password' }))
      : [blankRow()],
  )
  const [hideValues, setHideValues] = useState(!!existing?.hideValues)
  const [proxy, setProxy] = useState<ProxyForm>(() => {
    const p = existing?.proxy
    const uidOf = (key?: string) => (key ? fields.find((f) => f.key === key)?.uid ?? null : null)
    return {
      enabled: !!p,
      baseUid: uidOf(p?.baseUrlField),
      auth: p?.authHeader ? 'header' : p?.cookieField ? 'cookie' : 'header',
      headerName: p?.authHeader?.name ?? 'Authorization',
      prefix: p?.authHeader ? (p.authHeader.prefix ?? '') : 'Bearer ',
      cookieName: p?.cookieField?.name ?? '',
      valueUid: uidOf(p?.authHeader?.valueField ?? p?.cookieField?.valueField),
    }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function updateField(i: number, patch: Partial<FieldRow>) {
    setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  }
  function removeField(i: number) {
    setFields(fields.length <= 1 ? fields : fields.filter((_, j) => j !== i))
  }
  function addField() {
    setFields([...fields, blankRow()])
  }

  async function submit() {
    setError('')
    if (!name.trim()) { setError('Name is required'); return }
    const validFields = fields.filter((f) => f.label.trim())
    const keys = assignKeys(validFields)

    // Hiding the values only works with a proxy to call through.
    const useProxy = proxy.enabled || hideValues
    let proxyPayload: ConnectorInput['proxy'] = null
    if (useProxy) {
      const baseKey = proxy.baseUid !== null ? keys.get(proxy.baseUid) : undefined
      if (!baseKey) { setError('Pick the field that holds the service URL'); return }
      proxyPayload = { baseUrlField: baseKey }
      const valueKey = proxy.valueUid !== null ? keys.get(proxy.valueUid) : undefined
      if (proxy.auth === 'header') {
        if (!valueKey || !proxy.headerName.trim()) { setError('Pick the header and the field holding the credential'); return }
        proxyPayload.authHeader = { name: proxy.headerName.trim(), valueField: valueKey, ...(proxy.prefix ? { prefix: proxy.prefix } : {}) }
      } else if (proxy.auth === 'cookie') {
        if (!valueKey || !proxy.cookieName.trim()) { setError('Pick the cookie name and the field holding the credential'); return }
        proxyPayload.cookieField = { name: proxy.cookieName.trim(), valueField: valueKey }
      }
    }

    const payload: ConnectorInput = {
      name: name.trim(),
      description: description.trim(),
      icon: icon.trim() || 'Plug',
      fields: validFields.map((f) => ({ key: keys.get(f.uid), label: f.label.trim(), value: f.value, type: f.type })),
      proxy: proxyPayload,
      hideValues,
    }

    setSaving(true)
    try {
      if (existing) await api.updateConnector(existing.id, payload)
      else await api.createConnector(payload)
      onSaved()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='fixed inset-0 z-[200] flex items-center justify-center bg-black/40' onClick={onClose}>
      <div
        className='bg-surface border border-border rounded-xl p-5 w-full max-w-lg shadow-lg mx-4 max-h-[85vh] overflow-y-auto'
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className='font-medium text-text-primary mb-4'>
          {existing ? `Edit ${existing.name}` : 'Add connector'}
        </h3>

        {error && <div className='text-danger text-xs mb-3'>{error}</div>}

        {/* Name */}
        <label className='text-xs font-medium text-text-muted mb-1 block'>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='e.g. Notion, Gmail (papa)'
          className='w-full bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent focus:outline-none mb-3'
        />

        {/* Description */}
        <label className='text-xs font-medium text-text-muted mb-1 block'>Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder='What this connector is for (optional)'
          className='w-full bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent focus:outline-none mb-3'
        />

        {/* Icon */}
        <label className='text-xs font-medium text-text-muted mb-1.5 block'>Icon</label>
        <div className='flex flex-wrap gap-1.5 mb-2'>
          {ICON_CHOICES.map((n) => (
            <button
              key={n}
              onClick={() => setIcon(n)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                icon === n ? 'bg-accent text-white' : 'bg-surface2 text-text-muted hover:text-text-primary'
              }`}
              title={n}
            >
              <IconComponent name={n} size={16} />
            </button>
          ))}
          {isImageUrl(icon) && (
            <div className='w-8 h-8 rounded-lg flex items-center justify-center bg-surface2 ring-2 ring-accent overflow-hidden'>
              <IconComponent name={icon} size={16} />
            </div>
          )}
        </div>
        <input
          value={isImageUrl(icon) ? icon : ''}
          onChange={(e) => setIcon(e.target.value || 'Plug')}
          placeholder='…or paste a logo image URL'
          className='w-full bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-xs focus:border-accent focus:outline-none mb-4'
        />

        {/* Fields */}
        <label className='text-xs font-medium text-text-muted mb-1.5 block'>Fields</label>
        <p className='text-[11px] text-text-muted mb-2'>
          A label and its value (API key, URL, password…). Skills read these by name.
        </p>

        <div className='flex flex-col gap-2 mb-3'>
          {fields.map((field, i) => (
            <FieldRowInput
              key={field.uid}
              field={field}
              onChange={(patch) => updateField(i, patch)}
              onRemove={() => removeField(i)}
              canRemove={fields.length > 1}
            />
          ))}
        </div>

        <button
          onClick={addField}
          className='text-xs text-accent hover:text-accent-hover transition-colors mb-4 flex items-center gap-1'
        >
          <Plus size={13} /> Add field
        </button>

        <AccessSection
          fields={fields}
          hideValues={hideValues}
          setHideValues={setHideValues}
          proxy={proxy}
          setProxy={setProxy}
        />

        {/* Actions */}
        <div className='flex justify-end gap-2 pt-2 border-t border-border'>
          <button
            onClick={onClose}
            className='px-3 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors'
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className='bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors'
          >
            {saving ? 'Saving…' : existing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── How Jarvis uses it ────────────────────────────────────────────────────────

/**
 * Either Jarvis reads the values (and puts them in its own requests), or the
 * secret ones never reach it: it calls the service through the backend's
 * proxy, which adds the credential. The second needs a proxy, so choosing it
 * opens the proxy settings.
 */
function AccessSection({
  fields,
  hideValues,
  setHideValues,
  proxy,
  setProxy,
}: {
  fields: FieldRow[]
  hideValues: boolean
  setHideValues: (v: boolean) => void
  proxy: ProxyForm
  setProxy: (p: ProxyForm) => void
}) {
  const named = fields.filter((f) => f.label.trim())
  const options = [
    { value: '' as string, label: 'Pick a field' },
    ...named.map((f) => ({ value: String(f.uid), label: f.label.trim() })),
  ]
  const pick = (uid: number | null) => (uid === null ? '' : String(uid))
  const parse = (v: string) => (v ? Number(v) : null)
  const showProxy = proxy.enabled || hideValues
  const input = 'w-full bg-surface2 border border-border text-text-primary rounded-lg px-2.5 py-1.5 text-xs focus:border-accent focus:outline-none'

  return (
    <div className='border-t border-border pt-3 mb-4'>
      <label className='text-xs font-medium text-text-muted mb-1.5 block'>Jarvis's access</label>
      <label className='flex items-start gap-2 text-xs text-text-secondary mb-1.5 cursor-pointer'>
        <input type='radio' checked={!hideValues} onChange={() => setHideValues(false)} className='mt-0.5' />
        <span>Jarvis reads the values and uses them itself.</span>
      </label>
      <label className='flex items-start gap-2 text-xs text-text-secondary mb-2 cursor-pointer'>
        <input type='radio' checked={hideValues} onChange={() => setHideValues(true)} className='mt-0.5' />
        <span>
          Hide secret values from Jarvis. It calls the service through Jarvis's proxy, which adds the
          credential, so a prompt injection cannot read or leak it. Works for HTTP APIs.
        </span>
      </label>

      {!hideValues && (
        <label className='flex items-center gap-2 text-xs text-text-muted mb-2 cursor-pointer'>
          <input type='checkbox' checked={proxy.enabled} onChange={(e) => setProxy({ ...proxy, enabled: e.target.checked })} />
          <span>Also serve it through the proxy (for images and apps)</span>
        </label>
      )}

      {showProxy && (
        <div className='flex flex-col gap-2 bg-surface2/40 rounded-lg p-3'>
          <div>
            <div className='text-[11px] text-text-muted mb-1'>Service URL is in</div>
            <Select aria-label='URL field' value={pick(proxy.baseUid)} onChange={(v: string) => setProxy({ ...proxy, baseUid: parse(v) })} options={options} />
          </div>
          <div>
            <div className='text-[11px] text-text-muted mb-1'>Credential is sent as</div>
            <Select
              aria-label='Credential'
              value={proxy.auth}
              onChange={(auth: AuthMode) => setProxy({ ...proxy, auth })}
              options={[
                { value: 'header' as AuthMode, label: 'A header' },
                { value: 'cookie' as AuthMode, label: 'A cookie' },
                { value: 'none' as AuthMode, label: 'Nothing' },
              ]}
            />
          </div>
          {proxy.auth === 'header' && (
            <div className='flex gap-2'>
              <input value={proxy.headerName} onChange={(e) => setProxy({ ...proxy, headerName: e.target.value })} placeholder='Authorization' aria-label='Header name' className={input} />
              <input value={proxy.prefix} onChange={(e) => setProxy({ ...proxy, prefix: e.target.value })} placeholder='Prefix, e.g. Bearer ' aria-label='Prefix' className={input} />
            </div>
          )}
          {proxy.auth === 'cookie' && (
            <input value={proxy.cookieName} onChange={(e) => setProxy({ ...proxy, cookieName: e.target.value })} placeholder='Cookie name' aria-label='Cookie name' className={input} />
          )}
          {proxy.auth !== 'none' && (
            <div>
              <div className='text-[11px] text-text-muted mb-1'>Its value is in</div>
              <Select aria-label='Credential field' value={pick(proxy.valueUid)} onChange={(v: string) => setProxy({ ...proxy, valueUid: parse(v) })} options={options} />
            </div>
          )}
          {hideValues && (
            <p className='text-[11px] text-text-muted'>
              Fields of type Secret are withheld. Text and Email fields, like the URL, stay readable.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Field row (label + value + type) ──────────────────────────────────────────

function FieldRowInput({
  field,
  onChange,
  onRemove,
  canRemove,
}: {
  field: FieldRow
  onChange: (patch: Partial<FieldRow>) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const [visible, setVisible] = useState(false)
  const isSecret = field.type === 'password'

  return (
    <div className='flex gap-2 items-start'>
      <input
        value={field.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder='Label'
        className='flex-1 min-w-0 bg-surface2 border border-border text-text-primary rounded-lg px-2.5 py-1.5 text-xs focus:border-accent focus:outline-none'
      />
      <div className='flex-1 min-w-0 relative'>
        <input
          type={isSecret && !visible ? 'password' : field.type === 'email' ? 'email' : 'text'}
          value={field.value}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder='Value'
          autoComplete='off'
          className='w-full bg-surface2 border border-border text-text-primary rounded-lg px-2.5 py-1.5 text-xs focus:border-accent focus:outline-none pr-8'
        />
        {isSecret && (
          <button
            type='button'
            onClick={() => setVisible(!visible)}
            className='absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors'
          >
            {visible ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
      </div>
      <Select
        aria-label='Field type'
        value={field.type}
        onChange={(type: FieldRow['type']) => onChange({ type })}
        options={[
          { value: 'password' as FieldRow['type'], label: 'Secret' },
          { value: 'text' as FieldRow['type'], label: 'Text' },
          { value: 'email' as FieldRow['type'], label: 'Email' },
        ]}
      />
      <button
        onClick={onRemove}
        disabled={!canRemove}
        className='p-1.5 text-text-muted hover:text-danger disabled:opacity-30 transition-colors'
      >
        <X size={14} />
      </button>
    </div>
  )
}
