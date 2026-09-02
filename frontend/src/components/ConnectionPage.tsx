import { useState, useEffect } from 'react'
import {
  KeyRound,
  Terminal,
  Eye,
  EyeOff,
  Check,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Copy,
} from 'lucide-react'
import { api, type ConnectionStatus } from '../api'
import ContentLayout from './ContentLayout'
import { loadModelCatalogue } from './ModelSelector'

type Mode = 'anthropic' | 'gateway'

const GATEWAY_PRESETS: Array<{ label: string; baseUrl: string; hint: string }> = [
  {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    hint: 'Use an OpenRouter key (starts with sk-or-).',
  },
  {
    label: 'Custom',
    baseUrl: '',
    hint: 'Any Anthropic-compatible endpoint — LiteLLM, a self-hosted proxy, a corporate gateway.',
  },
]

export default function ConnectionPage() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('anthropic')
  const [baseUrl, setBaseUrl] = useState('')
  const [credential, setCredential] = useState('')
  const [showCredential, setShowCredential] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [copied, setCopied] = useState(false)

  async function load() {
    try {
      const s = await api.getConnection()
      setStatus(s)
      setMode(s.mode)
      setBaseUrl(s.baseUrl)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function save() {
    setSaving(true)
    setError('')
    setSaved('')
    try {
      const res = await api.setConnection({ mode, baseUrl, credential })
      setCredential('')
      setSaved(
        res.busy?.length
          ? `Saved and verified. ${res.busy.length} conversation(s) mid-reply will switch once their current turn ends.`
          : 'Saved and verified. Your next message uses it.',
      )
      await load()
      // The provider decides which models exist, so the picker's options are
      // stale the moment this succeeds — a gateway serves hundreds where the
      // Anthropic shortlist has four.
      await loadModelCatalogue(() => api.getModels())
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <ContentLayout title='Connection'>
        <div className='flex justify-center py-12 text-text-muted'>
          <Loader2 size={20} className='animate-spin' />
        </div>
      </ContentLayout>
    )
  }

  const preset = GATEWAY_PRESETS.find((p) => p.baseUrl === baseUrl)

  return (
    <ContentLayout title='Connection'>
      <div className='flex flex-col gap-5'>
        <p className='text-sm text-text-muted leading-relaxed'>
          Where Jarvis sends its thinking. Changes apply to your next message —
          no restart, no redeploy.
        </p>

        {/* Current state */}
        {status && (
          <div className='flex items-start gap-3 rounded-xl border border-border bg-surface p-4'>
            <div className={`mt-0.5 shrink-0 ${status.hasCredential ? 'text-green-500' : 'text-amber-500'}`}>
              {status.hasCredential ? <Check size={18} /> : <AlertTriangle size={18} />}
            </div>
            <div className='min-w-0 text-sm'>
              <p className='text-text-primary font-medium'>
                {status.hasCredential
                  ? status.mode === 'gateway'
                    ? `Connected via gateway`
                    : 'Connected to Claude (Anthropic)'
                  : 'No credentials set'}
              </p>
              {status.hasCredential && (
                <p className='text-text-muted mt-0.5 font-mono text-xs break-all'>
                  {status.mode === 'gateway' && `${status.baseUrl} · `}
                  {status.credentialHint}
                </p>
              )}
              {status.envManaged && (
                <p className='text-amber-600 dark:text-amber-500 mt-1.5 text-xs'>
                  Note: a value is also set in the environment (.env / compose).
                  That one wins until you remove it there.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Mode picker */}
        <div className='flex gap-2'>
          {(['anthropic', 'gateway'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(''); setSaved('') }}
              className={`flex-1 rounded-xl border px-4 py-3 text-sm transition-colors ${
                mode === m
                  ? 'border-accent bg-accent-subtle text-text-primary'
                  : 'border-border bg-surface text-text-secondary hover:text-text-primary'
              }`}
            >
              <span className='font-medium'>
                {m === 'anthropic' ? 'Claude subscription' : 'Gateway'}
              </span>
              <span className='block text-xs text-text-muted mt-0.5'>
                {m === 'anthropic' ? 'OAuth token' : 'OpenRouter, LiteLLM, proxy'}
              </span>
            </button>
          ))}
        </div>

        {/* Form */}
        <div className='rounded-2xl border border-border bg-surface p-5 flex flex-col gap-4'>
          {mode === 'anthropic' ? (
            <div className='flex flex-col gap-3'>
              <div className='flex items-center gap-2'>
                <Terminal size={16} className='text-accent' />
                <h2 className='text-sm font-medium text-text-primary'>Claude OAuth token</h2>
              </div>
              <p className='text-sm text-text-secondary'>
                Run <code className='bg-bg px-1.5 py-0.5 rounded text-xs'>claude setup-token</code>{' '}
                on any machine with the Claude CLI, sign in, and paste the{' '}
                <code className='bg-bg px-1.5 py-0.5 rounded text-xs'>sk-ant-oat01-…</code> token it prints.
                <button
                  onClick={() => {
                    navigator.clipboard.writeText('claude setup-token')
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  className='inline-flex items-center gap-1 text-accent hover:underline ml-1.5'
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'copied' : 'copy command'}
                </button>
              </p>
              <p className='text-xs text-text-muted'>
                Don't use the token from <code>~/.claude/.credentials.json</code> — it expires within hours.
              </p>
            </div>
          ) : (
            <div className='flex flex-col gap-3'>
              <div className='flex items-center gap-2'>
                <KeyRound size={16} className='text-accent' />
                <h2 className='text-sm font-medium text-text-primary'>Gateway endpoint</h2>
              </div>
              <div className='flex gap-2'>
                {GATEWAY_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setBaseUrl(p.baseUrl)}
                    className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                      (preset?.label ?? 'Custom') === p.label
                        ? 'border-accent text-text-primary bg-accent-subtle'
                        : 'border-border text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                type='text'
                placeholder='https://openrouter.ai/api'
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className='bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 text-sm font-mono focus:border-accent transition-colors outline-none'
              />
              <p className='text-xs text-text-muted'>
                {preset?.hint ??
                  'Any Anthropic-compatible endpoint. Jarvis sends the key below as the API key.'}{' '}
                <a
                  href='https://openrouter.ai/keys'
                  target='_blank'
                  rel='noreferrer'
                  className='inline-flex items-center gap-0.5 text-accent hover:underline'
                >
                  OpenRouter keys <ExternalLink size={10} />
                </a>
              </p>
              <p className='text-xs text-text-muted'>
                Your Claude OAuth token is never sent to a gateway — it stays stored
                and comes back if you switch to "Claude subscription".
              </p>
            </div>
          )}

          {/* Credential */}
          <div className='relative'>
            <input
              type={showCredential ? 'text' : 'password'}
              placeholder={mode === 'anthropic' ? 'sk-ant-oat01-…' : 'sk-or-…'}
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete='off'
              className='w-full bg-bg border border-border text-text-primary rounded-xl px-3.5 py-2.5 pr-10 text-sm font-mono focus:border-accent transition-colors outline-none'
            />
            <button
              type='button'
              onClick={() => setShowCredential(!showCredential)}
              className='absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors'
            >
              {showCredential ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {error && (
            <div className='text-sm bg-accent-subtle rounded-lg px-3 py-2.5 flex gap-2'>
              <AlertTriangle size={16} className='text-danger shrink-0 mt-0.5' />
              <div className='min-w-0'>
                <p className='text-danger font-medium'>Verification failed</p>
                <pre className='text-text-secondary text-xs mt-1 whitespace-pre-wrap break-words font-mono'>
                  {error}
                </pre>
              </div>
            </div>
          )}
          {saved && (
            <div className='text-sm text-green-600 dark:text-green-500 bg-accent-subtle rounded-lg px-3 py-2 flex items-center gap-2'>
              <Check size={16} className='shrink-0' />
              {saved}
            </div>
          )}

          <button
            onClick={save}
            disabled={saving || !credential.trim() || (mode === 'gateway' && !baseUrl.trim())}
            className='bg-accent text-white py-2.5 px-4 rounded-xl font-medium hover:bg-accent-hover disabled:opacity-60 transition-colors text-sm flex items-center justify-center gap-2'
          >
            {saving ? (
              <>
                <Loader2 size={16} className='animate-spin' />
                Verifying…
              </>
            ) : (
              'Verify and save'
            )}
          </button>
          <p className='text-xs text-text-muted text-center'>
            Jarvis runs a real test message before saving, so a bad key is caught
            here rather than failing every conversation later.
          </p>
        </div>
      </div>
    </ContentLayout>
  )
}
