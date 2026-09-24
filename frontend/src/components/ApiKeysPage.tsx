import { useEffect, useState } from 'react'
import { Copy, Check, KeyRound } from 'lucide-react'
import { api, type ApiKey } from '../api'

function when(ts: number | null): string {
  if (!ts) return 'never'
  return new Date(ts * 1000).toLocaleString('fr-FR')
}

export default function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  /** The plaintext of the key just created. Held in component state only — it
   *  is unrecoverable once this page is left, which is what the banner says. */
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  async function load() {
    setKeys(await api.getApiKeys())
  }

  useEffect(() => {
    load()
  }, [])

  async function create() {
    if (!name.trim()) return
    setCreating(true)
    setError('')
    try {
      const created = await api.createApiKey(name.trim())
      setFresh({ name: created.name, key: created.key })
      setCopied(false)
      setName('')
      load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  async function revoke(id: string) {
    await api.deleteApiKey(id)
    setConfirming(null)
    load()
  }

  function copyKey(key: string) {
    navigator.clipboard.writeText(key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const origin = window.location.origin

  return (
    <div className='flex flex-col gap-3'>
      {/* The one time the secret is visible. */}
      {fresh && (
        <div className='bg-surface border border-accent/50 rounded-2xl px-4 py-3 flex flex-col gap-2'>
          <div className='text-sm text-text-primary'>
            “{fresh.name}” created — copy it now, it is shown once.
          </div>
          <div className='flex gap-2 items-center'>
            <code className='flex-1 bg-bg border border-border rounded-lg px-3 py-1.5 text-xs font-mono break-all text-text-primary'>
              {fresh.key}
            </code>
            <button
              onClick={() => copyKey(fresh.key)}
              className='shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-text-primary hover:border-accent transition-colors'
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => setFresh(null)}
            className='self-start text-xs text-text-muted hover:text-text-primary transition-colors'
          >
            I've saved it — hide
          </button>
        </div>
      )}

      <div className='rounded-2xl border border-border bg-surface divide-y divide-border'>
        {keys.map((k) => (
          <div key={k.id} className='px-4 py-3 flex items-center gap-3'>
            <KeyRound size={14} className='shrink-0 text-text-muted' />
            <div className='flex-1 min-w-0'>
              <div className='text-sm text-text-primary truncate'>{k.name}</div>
              <div className='text-xs text-text-muted truncate'>
                <span className='font-mono'>{k.prefix}</span> · last used {when(k.last_used_at)}
              </div>
            </div>
            {confirming === k.id ? (
              <div className='flex gap-2 items-center shrink-0'>
                <button onClick={() => revoke(k.id)} className='text-xs text-danger hover:opacity-80 transition-opacity'>
                  Revoke
                </button>
                <button onClick={() => setConfirming(null)} className='text-xs text-text-muted hover:text-text-primary transition-colors'>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming(k.id)}
                className='shrink-0 text-xs text-text-muted hover:text-danger transition-colors'
              >
                Revoke
              </button>
            )}
          </div>
        ))}
        <div className='px-4 py-2.5 flex gap-2 items-center'>
          <input
            placeholder='New key — what is it for?'
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
            className='flex-1 min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none'
          />
          <button
            onClick={create}
            disabled={!name.trim() || creating}
            className='shrink-0 inline-flex items-center rounded-lg border border-border bg-bg px-2.5 py-1 text-xs text-text-primary hover:border-accent transition-colors disabled:opacity-50'
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
      {error && <div className='text-danger text-xs'>{error}</div>}

      {/* What a key is for. Deliberately concrete: there is no separate API to
          learn, so the example is a real call. Folded: read once, then it's noise. */}
      <details className='text-xs text-text-muted'>
        <summary className='cursor-pointer select-none hover:text-text-primary'>How to use a key</summary>
        <p className='mt-2'>
          It authenticates the same API this interface uses, as a bearer token. It carries full account
          access and never expires; it cannot create or revoke keys, so a leaked one can be cut off.
        </p>
        <pre className='mt-2 bg-bg border border-border rounded-lg p-3 overflow-x-auto text-text-secondary font-mono leading-relaxed'>
{`curl -X POST ${origin}/api/conversations/<id>/messages \\
  -H "Authorization: Bearer jarvis_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"content": "What is on my calendar today?"}'`}
        </pre>
      </details>
    </div>
  )
}
