import { useState, useEffect } from 'react'
import {
  Mail,
  GitBranch,
  SquareKanban,
  Image,
  Database,
  Check,
  Eye,
  EyeOff,
  Plug,
  Loader2,
  X,
  Plus,
  Trash2,
  Pencil,
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
import { api, type ConnectorInfo, type ConnectorDetail, type ConnectorField } from '../api'
import ContentLayout from './ContentLayout'

const ICON_MAP: Record<string, LucideIcon> = {
  Mail, Github: GitBranch, SquareKanban, Image, Database, MessageSquare,
  HardDrive, AudioLines, Globe, Key, Cloud, Zap, Bot, Plug,
}

const ICON_CHOICES = Object.keys(ICON_MAP)

function IconComponent({ name, size = 20 }: { name: string; size?: number }) {
  const Icon = ICON_MAP[name] ?? Plug
  return <Icon size={size} />
}

type TestState = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok'; message: string } | { kind: 'err'; message: string }

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConnectorDetail | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [showCreate, setShowCreate] = useState(false)

  async function load() {
    setConnectors(await api.getConnectors())
  }

  useEffect(() => { load() }, [])

  async function startEdit(id: string) {
    setError('')
    setTest({ kind: 'idle' })
    try {
      const d = await api.getConnector(id)
      setDetail(d)
      setForm(d.secrets)
      setEditing(id)
    } catch (err: any) {
      setError(err.message)
    }
  }

  function cancelEdit() {
    setEditing(null)
    setDetail(null)
    setForm({})
    setError('')
    setTest({ kind: 'idle' })
  }

  async function save() {
    if (!editing || !detail) return
    setSaving(true)
    setError('')
    try {
      await api.saveConnector(editing, form)
      cancelEdit()
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function runTest() {
    if (!editing) return
    setTest({ kind: 'running' })
    try {
      const r = await api.testConnector(editing, form)
      setTest(r.ok ? { kind: 'ok', message: r.message } : { kind: 'err', message: r.message })
    } catch (err: any) {
      setTest({ kind: 'err', message: err.message || 'Test failed' })
    }
  }

  async function disconnect(id: string) {
    await api.deleteConnector(id)
    if (editing === id) cancelEdit()
    load()
  }

  async function deleteCustom(id: string) {
    await api.deleteCustomConnector(id)
    load()
  }

  return (
    <ContentLayout title='Connectors'>
      <p className='text-text-muted text-sm mb-6'>
        Configure API keys and tokens for skills that need external services.
      </p>

      {error && !editing && (
        <div className='text-danger text-sm mb-4 bg-surface border border-danger/20 rounded-lg px-4 py-3'>
          {error}
        </div>
      )}

      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        {[...connectors].sort((a, b) => (b.connected ? 1 : 0) - (a.connected ? 1 : 0)).map((c) => (
          <ConnectorCard
            key={c.id}
            connector={c}
            isEditing={editing === c.id}
            onConfigure={() => startEdit(c.id)}
            onDisconnect={() => disconnect(c.id)}
            onDeleteCustom={c.custom ? () => deleteCustom(c.id) : undefined}
          />
        ))}
        <button
          onClick={() => setShowCreate(true)}
          className='border border-dashed border-border rounded-xl px-4 py-4 flex items-center gap-3 text-text-muted hover:text-text-primary hover:border-accent/40 hover:bg-surface transition-colors'
        >
          <div className='w-10 h-10 rounded-lg bg-surface2 flex items-center justify-center'>
            <Plus size={20} />
          </div>
          <div className='text-left'>
            <div className='text-sm font-medium'>Add custom connector</div>
            <div className='text-xs opacity-70'>Define your own env vars</div>
          </div>
        </button>
      </div>

      {/* Secrets edit modal */}
      {editing && detail && (
        <div
          className='fixed inset-0 z-[200] flex items-center justify-center bg-black/40'
          onClick={cancelEdit}
        >
          <div
            className='bg-surface border border-border rounded-xl p-5 w-full max-w-md shadow-lg mx-4'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='flex items-center gap-3 mb-4'>
              <div className='w-10 h-10 rounded-lg bg-surface2 flex items-center justify-center text-text-muted'>
                <IconComponent name={detail.icon} />
              </div>
              <div>
                <h3 className='font-medium text-text-primary'>{detail.name}</h3>
                <p className='text-xs text-text-muted'>{detail.description}</p>
              </div>
            </div>

            {error && (
              <div className='text-danger text-xs mb-3 px-1'>{error}</div>
            )}

            <div className='flex flex-col gap-3'>
              {detail.fields.map((field) => (
                <FieldInput
                  key={field.key}
                  field={field}
                  value={form[field.key] || ''}
                  onChange={(v) => setForm({ ...form, [field.key]: v })}
                />
              ))}
            </div>

            {test.kind !== 'idle' && (
              <div
                role='status'
                className={`
                  mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs border
                  ${test.kind === 'ok' ? 'border-green-500/40 text-green-500 bg-green-500/5' : ''}
                  ${test.kind === 'err' ? 'border-danger/40 text-danger bg-danger/5' : ''}
                  ${test.kind === 'running' ? 'border-border text-text-muted bg-surface2' : ''}
                `}
              >
                {test.kind === 'running' && <Loader2 size={13} className='animate-spin mt-0.5' />}
                {test.kind === 'ok' && <Check size={13} className='mt-0.5' />}
                {test.kind === 'err' && <X size={13} className='mt-0.5' />}
                <span className='flex-1 break-words'>
                  {test.kind === 'running' ? 'Testing connection…' : test.message}
                </span>
              </div>
            )}

            <div className='flex justify-between gap-2 mt-5'>
              <button
                onClick={runTest}
                disabled={test.kind === 'running' || saving}
                className='text-sm text-text-secondary hover:text-text-primary disabled:opacity-50 transition-colors px-2 py-2'
              >
                Test connection
              </button>
              <div className='flex gap-2'>
                <button
                  onClick={cancelEdit}
                  className='px-3 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors'
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className='bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors'
                >
                  {saving ? 'Saving...' : detail.connected ? 'Update' : 'Connect'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create custom connector modal */}
      {showCreate && (
        <CreateCustomModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load() }}
        />
      )}
    </ContentLayout>
  )
}

// ── Connector card ──────────────────────────────────────────────────────────

function ConnectorCard({
  connector,
  isEditing,
  onConfigure,
  onDisconnect,
  onDeleteCustom,
}: {
  connector: ConnectorInfo
  isEditing: boolean
  onConfigure: () => void
  onDisconnect: () => void
  onDeleteCustom?: () => void
}) {
  return (
    <div
      className={`
        bg-surface border rounded-xl px-4 py-4 flex flex-col gap-3 transition-colors
        ${connector.connected ? 'border-green-500/30' : 'border-border'}
        ${isEditing ? 'ring-2 ring-accent' : ''}
      `}
    >
      <div className='flex items-start gap-3'>
        <div className='w-10 h-10 rounded-lg bg-surface2 flex items-center justify-center text-text-muted shrink-0'>
          <IconComponent name={connector.icon} />
        </div>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2'>
            <span className='font-medium text-sm text-text-primary'>
              {connector.name}
            </span>
            {connector.connected && (
              <span className='flex items-center gap-1 text-[11px] text-green-500 font-medium'>
                <Check size={12} />
                Connected
              </span>
            )}
            {connector.custom && (
              <span className='text-[10px] text-text-muted bg-surface2 px-1.5 py-0.5 rounded font-medium'>
                Custom
              </span>
            )}
          </div>
          <p className='text-xs text-text-muted mt-0.5'>
            {connector.description}
          </p>
        </div>
      </div>

      <div className='flex items-center gap-2'>
        <button
          onClick={onConfigure}
          className={`
            text-xs px-3 py-1.5 rounded-lg font-medium transition-colors
            ${connector.connected
              ? 'text-text-secondary hover:text-text-primary hover:bg-surface2'
              : 'bg-accent text-white hover:bg-accent-hover'
            }
          `}
        >
          {connector.connected ? 'Edit' : 'Connect'}
        </button>
        {connector.connected && (
          <button
            onClick={onDisconnect}
            className='text-xs px-3 py-1.5 rounded-lg text-danger hover:bg-surface2 transition-colors'
          >
            Disconnect
          </button>
        )}
        {onDeleteCustom && !connector.connected && (
          <button
            onClick={onDeleteCustom}
            className='text-xs px-2 py-1.5 rounded-lg text-danger hover:bg-surface2 transition-colors'
            title='Delete custom connector'
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Create custom connector modal ───────────────────────────────────────────

interface FieldDraft {
  key: string
  label: string
  type: 'text' | 'password' | 'email'
}

function CreateCustomModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('Plug')
  const [fields, setFields] = useState<FieldDraft[]>([{ key: '', label: '', type: 'password' }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function updateField(i: number, patch: Partial<FieldDraft>) {
    setFields(fields.map((f, j) => j === i ? { ...f, ...patch } : f))
  }

  function removeField(i: number) {
    if (fields.length <= 1) return
    setFields(fields.filter((_, j) => j !== i))
  }

  function addField() {
    setFields([...fields, { key: '', label: '', type: 'password' }])
  }

  async function submit() {
    setError('')
    if (!name.trim()) { setError('Name is required'); return }

    const validFields = fields.filter((f) => f.key.trim() && f.label.trim())
    if (!validFields.length) { setError('At least one field with a key and label is required'); return }

    setSaving(true)
    try {
      await api.createCustomConnector({
        name: name.trim(),
        description: description.trim(),
        icon,
        fields: validFields.map((f) => ({
          key: f.key.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
          label: f.label.trim(),
          type: f.type,
        })),
      })
      onCreated()
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
        <h3 className='font-medium text-text-primary mb-4'>Create custom connector</h3>

        {error && <div className='text-danger text-xs mb-3'>{error}</div>}

        {/* Name */}
        <label className='text-xs font-medium text-text-muted mb-1 block'>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='e.g. Notion'
          className='w-full bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent focus:outline-none mb-3'
        />

        {/* Description */}
        <label className='text-xs font-medium text-text-muted mb-1 block'>Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder='What this connector does'
          className='w-full bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent focus:outline-none mb-3'
        />

        {/* Icon picker */}
        <label className='text-xs font-medium text-text-muted mb-1.5 block'>Icon</label>
        <div className='flex flex-wrap gap-1.5 mb-4'>
          {ICON_CHOICES.map((name) => (
            <button
              key={name}
              onClick={() => setIcon(name)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                icon === name
                  ? 'bg-accent text-white'
                  : 'bg-surface2 text-text-muted hover:text-text-primary hover:bg-surface2'
              }`}
              title={name}
            >
              <IconComponent name={name} size={16} />
            </button>
          ))}
        </div>

        {/* Fields */}
        <label className='text-xs font-medium text-text-muted mb-1.5 block'>
          Environment variables
        </label>
        <p className='text-[11px] text-text-muted mb-2'>
          Each field becomes an env var injected into the AI process.
        </p>

        <div className='flex flex-col gap-2 mb-3'>
          {fields.map((field, i) => (
            <div key={i} className='flex gap-2 items-start'>
              <div className='flex-1 min-w-0'>
                <input
                  value={field.key}
                  onChange={(e) => updateField(i, { key: e.target.value })}
                  placeholder='ENV_VAR_NAME'
                  className='w-full bg-surface2 border border-border text-text-primary rounded-lg px-2.5 py-1.5 text-xs font-mono focus:border-accent focus:outline-none'
                />
              </div>
              <div className='flex-1 min-w-0'>
                <input
                  value={field.label}
                  onChange={(e) => updateField(i, { label: e.target.value })}
                  placeholder='Display label'
                  className='w-full bg-surface2 border border-border text-text-primary rounded-lg px-2.5 py-1.5 text-xs focus:border-accent focus:outline-none'
                />
              </div>
              <select
                value={field.type}
                onChange={(e) => updateField(i, { type: e.target.value as FieldDraft['type'] })}
                className='bg-surface2 border border-border text-text-primary rounded-lg px-2 py-1.5 text-xs focus:border-accent focus:outline-none'
              >
                <option value='password'>Secret</option>
                <option value='text'>Text</option>
                <option value='email'>Email</option>
              </select>
              <button
                onClick={() => removeField(i)}
                disabled={fields.length <= 1}
                className='p-1.5 text-text-muted hover:text-danger disabled:opacity-30 transition-colors'
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={addField}
          className='text-xs text-accent hover:text-accent-hover transition-colors mb-4 flex items-center gap-1'
        >
          <Plus size={13} /> Add field
        </button>

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
            {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Field input ─────────────────────────────────────────────────────────────

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ConnectorField
  value: string
  onChange: (v: string) => void
}) {
  const [visible, setVisible] = useState(false)
  const isSecret = field.type === 'password'

  return (
    <div>
      <label className='text-xs font-medium text-text-muted mb-1 block'>
        {field.label}
      </label>
      <div className='relative'>
        <input
          type={isSecret && !visible ? 'password' : field.type === 'email' ? 'email' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          autoComplete='off'
          className='w-full bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent focus:outline-none pr-9'
        />
        {isSecret && (
          <button
            type='button'
            onClick={() => setVisible(!visible)}
            className='absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors'
          >
            {visible ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </div>
    </div>
  )
}
