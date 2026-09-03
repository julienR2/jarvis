import { useEffect, useState } from 'react'
import { Check, Loader2, ChevronDown, KeyRound, Trash2, ExternalLink, Eye, EyeOff } from 'lucide-react'
import ContentLayout from './ContentLayout'
import { api } from '../api'
import type { ConnectionStatus, ProviderStatus } from '../api'
import { loadModelCatalogue, useModelCatalogue, modelName } from './ModelSelector'
import GatewayModelPicker from './GatewayModelPicker'

type Mode = 'anthropic' | 'gateway'

const OPENROUTER = 'https://openrouter.ai/api'

/**
 * Where Jarvis sends its thinking.
 *
 * Two independent providers rather than a mode: with both configured, the model
 * picker offers Claude's models and the gateway's together, and whichever model
 * a conversation is on decides where its turn goes. So each is its own card,
 * and a configured one collapses to a summary — it is settled, and settled
 * things shouldn't occupy a screen.
 */
/** The two provider cards, embeddable wherever credentials are managed. */
export function ProviderConnections() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setStatus(await api.getConnection())
  }

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className='flex justify-center py-6 text-text-muted'>
        <Loader2 size={18} className='animate-spin' />
      </div>
    )
  }

  return (
    <div className='flex flex-col gap-3'>
      <p className='text-sm text-text-muted'>
        Where Jarvis sends its thinking. Set up either or both — with both, new
        conversations start on whichever you mark as default, and you can still
        change model per conversation. Changes apply to your next message — no
        restart, no redeploy.
      </p>

      <ProviderCard
        mode='anthropic'
        title='Claude subscription'
        subtitle='OAuth token from your Claude plan'
        status={status!.anthropic}
        isDefault={status!.defaultProvider === 'anthropic'}
        // Only a real choice when both are set up; with one it is simply where
        // everything goes, and a control that can't be changed is noise.
        canChooseDefault={status!.anthropic.configured && status!.gateway.configured}
        onChanged={load}
      />
      <ProviderCard
        mode='gateway'
        title='Gateway'
        subtitle='OpenRouter, LiteLLM, or any Anthropic-compatible proxy'
        status={status!.gateway}
        isDefault={status!.defaultProvider === 'gateway'}
        canChooseDefault={status!.anthropic.configured && status!.gateway.configured}
        onChanged={load}
      />
    </div>
  )
}

export default function ConnectionPage() {
  return (
    <ContentLayout title='Connection'>
      <div className='max-w-2xl mx-auto px-4 md:px-6 py-6'>
        <ProviderConnections />
      </div>
    </ContentLayout>
  )
}

function ProviderCard({
  mode, title, subtitle, status, isDefault, canChooseDefault, onChanged,
}: {
  mode: Mode
  title: string
  subtitle: string
  status: ProviderStatus
  isDefault: boolean
  canChooseDefault: boolean
  onChanged: () => Promise<void>
}) {
  // Configured providers start collapsed: the common case is checking that it
  // is still set, not changing it.
  const [open, setOpen] = useState(!status.configured)
  const [credential, setCredential] = useState('')
  const [baseUrl, setBaseUrl] = useState(status.baseUrl || OPENROUTER)
  const [reveal, setReveal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  async function save() {
    setSaving(true)
    setError('')
    setSaved('')
    try {
      const res = await api.setConnection({ mode, baseUrl, credential })
      setCredential('')
      setSaved(
        res.busy?.length
          ? `Verified and saved. ${res.busy.length} conversation(s) mid-reply will switch once their turn ends.`
          : 'Verified and saved.',
      )
      await onChanged()
      // The provider decides which models exist, so the picker is stale now.
      await loadModelCatalogue(() => api.getModels())
      setOpen(false)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function forget() {
    if (!confirm(`Remove the ${title.toLowerCase()} credentials?`)) return
    setSaving(true)
    try {
      await api.clearConnection(mode)
      await onChanged()
      await loadModelCatalogue(() => api.getModels())
      setOpen(true)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='rounded-2xl border border-border bg-surface overflow-hidden'>
      <button
        onClick={() => setOpen(!open)}
        className='w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface2 transition-colors'
      >
        <span className={`shrink-0 ${status.configured ? 'text-green-600 dark:text-green-500' : 'text-text-muted'}`}>
          {status.configured ? <Check size={16} /> : <KeyRound size={16} />}
        </span>
        <span className='flex-1 min-w-0'>
          <span className='block text-sm font-medium text-text-primary'>{title}</span>
          <span className='block text-xs text-text-muted truncate font-mono'>
            {status.configured
              ? `${status.baseUrl ? `${status.baseUrl} · ` : ''}${status.credentialHint}`
              : subtitle}
          </span>
        </span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {status.configured && (
        <ProviderDefaults
          mode={mode}
          isDefault={isDefault}
          canChooseDefault={canChooseDefault}
          defaultModel={status.defaultModel}
          onChanged={onChanged}
        />
      )}

      {open && (
        <div className='px-4 pb-4 pt-1 flex flex-col gap-3 border-t border-border'>
          {status.envManaged && (
            <p className='text-amber-600 dark:text-amber-500 text-xs'>
              A value is also set in the environment (.env / compose). That one
              wins until you remove it there.
            </p>
          )}

          {mode === 'gateway' && (
            <div className='flex flex-col gap-1.5'>
              <div className='flex gap-2'>
                <Chip active={baseUrl === OPENROUTER} onClick={() => setBaseUrl(OPENROUTER)}>
                  OpenRouter
                </Chip>
                <Chip active={baseUrl !== OPENROUTER} onClick={() => setBaseUrl('')}>
                  Custom
                </Chip>
              </div>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder='https://…'
                className='w-full bg-bg border border-border rounded-xl px-3 py-2 text-sm font-mono text-text-primary outline-none focus:border-accent'
              />
              {baseUrl === OPENROUTER && (
                <p className='text-xs text-text-muted'>
                  Use an OpenRouter key (starts with sk-or-).{' '}
                  <a
                    href='https://openrouter.ai/keys'
                    target='_blank'
                    rel='noreferrer'
                    className='text-accent hover:underline inline-flex items-center gap-0.5'
                  >
                    OpenRouter keys <ExternalLink size={11} />
                  </a>
                </p>
              )}
            </div>
          )}

          <div className='relative'>
            <input
              type={reveal ? 'text' : 'password'}
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder={mode === 'gateway' ? 'sk-or-…' : 'sk-ant-oat01-…'}
              className='w-full bg-bg border border-border rounded-xl px-3 py-2 pr-10 text-sm font-mono text-text-primary outline-none focus:border-accent'
            />
            <button
              onClick={() => setReveal(!reveal)}
              className='absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary p-1'
              aria-label={reveal ? 'Hide' : 'Show'}
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          <button
            onClick={save}
            disabled={saving || !credential.trim() || (mode === 'gateway' && !baseUrl.trim())}
            className='bg-accent text-white rounded-xl py-2.5 text-sm font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors'
          >
            {saving ? 'Verifying…' : 'Verify and save'}
          </button>

          <p className='text-xs text-text-muted'>
            Jarvis runs a real test message before saving, so a bad key is caught
            here rather than failing every conversation later.
          </p>

          {error && <p className='text-danger text-sm'>{error}</p>}
          {saved && <p className='text-green-600 dark:text-green-500 text-sm'>{saved}</p>}

          {status.configured && (
            <button
              onClick={forget}
              disabled={saving}
              className='self-start text-xs text-danger hover:underline inline-flex items-center gap-1'
            >
              <Trash2 size={12} /> Remove these credentials
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Chip({
  active, onClick, children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-lg text-xs border transition-colors ${
        active ? 'border-accent text-accent bg-accent/10' : 'border-border text-text-muted hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}


/**
 * Where new conversations start: which provider, and on which model.
 *
 * Deliberately outside the card's disclosure. A credential is set once and
 * checked rarely, which is why a configured card collapses — but the default
 * is the thing you come back to change, and burying it behind the same toggle
 * as the token would hide the setting behind the one you don't need.
 *
 * Both write through to the server immediately: there is no Save here, because
 * a preference with a save button invites the half-applied state where the
 * radio says one thing and new conversations do another.
 */
function ProviderDefaults({
  mode, isDefault, canChooseDefault, defaultModel, onChanged,
}: {
  mode: Mode
  isDefault: boolean
  canChooseDefault: boolean
  defaultModel: string
  onChanged: () => Promise<void>
}) {
  const { anthropic, gateway } = useModelCatalogue()
  const [picking, setPicking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Only models that can actually run the agent. An image model as the default
  // would turn every new conversation into an image generator.
  const choices = (mode === 'gateway' ? gateway : anthropic).filter(
    (m) => (m.kind ?? 'text') === 'text',
  )

  async function save(patch: Parameters<typeof api.setConnectionDefaults>[0]) {
    setSaving(true)
    setError('')
    try {
      await api.setConnectionDefaults(patch)
      await onChanged()
      // The instance default moved, so the picker's idea of it is stale.
      await loadModelCatalogue(() => api.getModels())
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='px-4 py-2.5 border-t border-border flex flex-wrap items-center gap-x-4 gap-y-2'>
      {canChooseDefault ? (
        <label className='flex items-center gap-2 text-xs cursor-pointer select-none'>
          <input
            type='radio'
            name='default-provider'
            checked={isDefault}
            disabled={saving}
            onChange={() => save({ provider: mode })}
            className='accent-accent'
          />
          <span className={isDefault ? 'text-text-primary font-medium' : 'text-text-muted'}>
            Default for new chats
          </span>
        </label>
      ) : (
        <span className='text-xs text-text-muted'>Default for new chats</span>
      )}

      <div className='flex items-center gap-2 text-xs ml-auto min-w-0'>
        <span className='text-text-muted shrink-0'>Starts on</span>
        {mode === 'gateway' ? (
          <button
            onClick={() => setPicking(true)}
            disabled={saving}
            className='max-w-[220px] truncate rounded-lg border border-border bg-bg px-2 py-1 text-text-primary hover:border-accent disabled:opacity-60 transition-colors'
          >
            {modelName(defaultModel)}
          </button>
        ) : (
          <select
            value={defaultModel}
            disabled={saving}
            onChange={(e) => save({ anthropicModel: e.target.value })}
            className='rounded-lg border border-border bg-bg px-2 py-1 text-text-primary outline-none focus:border-accent disabled:opacity-60'
          >
            {/* The stored default may not be in the list (a model that has since
                been retired) — keep it selectable rather than silently showing
                a different one as current. */}
            {!choices.some((m) => m.id === defaultModel) && (
              <option value={defaultModel}>{modelName(defaultModel)}</option>
            )}
            {choices.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        )}
        {saving && <Loader2 size={13} className='animate-spin text-text-muted' />}
      </div>

      {error && <p className='w-full text-danger text-xs'>{error}</p>}

      {picking && (
        <GatewayModelPicker
          models={choices}
          selected={defaultModel}
          onSelect={(id) => {
            setPicking(false)
            save({ gatewayModel: id })
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  )
}
