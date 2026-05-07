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
} from 'lucide-react'
import { api, type ConnectorInfo, type ConnectorDetail, type ConnectorField } from '../api'
import ContentLayout from './ContentLayout'

const ICONS: Record<string, React.ReactNode> = {
  Mail: <Mail size={20} />,
  Github: <GitBranch size={20} />,
  SquareKanban: <SquareKanban size={20} />,
  Image: <Image size={20} />,
  Database: <Database size={20} />,
}

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConnectorDetail | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setConnectors(await api.getConnectors())
  }

  useEffect(() => { load() }, [])

  async function startEdit(id: string) {
    setError('')
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

  async function disconnect(id: string) {
    await api.deleteConnector(id)
    if (editing === id) cancelEdit()
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
        {connectors.map((c) => (
          <ConnectorCard
            key={c.id}
            connector={c}
            isEditing={editing === c.id}
            onConfigure={() => startEdit(c.id)}
            onDisconnect={() => disconnect(c.id)}
          />
        ))}
      </div>

      {/* Edit modal */}
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
                {ICONS[detail.icon] ?? <Plug size={20} />}
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

            <div className='flex justify-end gap-2 mt-5'>
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
      )}
    </ContentLayout>
  )
}

function ConnectorCard({
  connector,
  isEditing,
  onConfigure,
  onDisconnect,
}: {
  connector: ConnectorInfo
  isEditing: boolean
  onConfigure: () => void
  onDisconnect: () => void
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
          {ICONS[connector.icon] ?? <Plug size={20} />}
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
      </div>
    </div>
  )
}

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
