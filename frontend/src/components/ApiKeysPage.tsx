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
    <div>
      {/* What a key is for. Deliberately concrete: the whole point is that
          there is no separate API to learn, so the example is a real call. */}
      <div className='bg-surface2/50 border border-border rounded-xl p-4 mb-6 text-xs text-text-muted'>
        <div className='font-medium text-text-secondary text-sm mb-2'>Using a key</div>
        <p className='mb-2'>
          A key authenticates the same API this interface uses — every endpoint, same
          shapes. Send it as a bearer token:
        </p>
        <pre className='bg-bg rounded-lg p-3 overflow-x-auto text-text-secondary font-mono leading-relaxed'>
{`curl ${origin}/api/conversations \\
  -H "Authorization: Bearer jarvis_sk_..."

curl -X POST ${origin}/api/conversations/<id>/messages \\
  -H "Authorization: Bearer jarvis_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{"content": "What is on my calendar today?"}'`}
        </pre>
        <p className='mt-2'>
          A key carries your full account access and never expires — treat it like a
          password. It cannot create or revoke keys: that takes a signed-in session, so
          a leaked key can be cut off for good.
        </p>
      </div>

      {/* Create */}
      <div className='bg-surface border border-border rounded-xl p-5 mb-6 flex flex-col gap-3'>
        <h3 className='font-medium text-sm'>New key</h3>
        {error && <div className='text-danger text-xs'>{error}</div>}
        <div className='flex gap-2'>
          <input
            placeholder='What is it for? (e.g. laptop scripts, n8n)'
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
            className='flex-1 bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent'
          />
          <button
            onClick={create}
            disabled={!name.trim() || creating}
            className='bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors'
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>

      {/* The one time the secret is visible. */}
      {fresh && (
        <div className='bg-surface border border-accent/50 rounded-xl p-5 mb-6 flex flex-col gap-3'>
          <div className='text-sm font-medium'>
            Key created — copy it now
          </div>
          <div className='text-xs text-text-muted'>
            “{fresh.name}” is shown once. Jarvis stores only a hash, so if you lose it
            you create a new one.
          </div>
          <div className='flex gap-2 items-center'>
            <code className='flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-xs font-mono break-all text-text-primary'>
              {fresh.key}
            </code>
            <button
              onClick={() => copyKey(fresh.key)}
              className='shrink-0 flex items-center gap-1.5 bg-surface2 border border-border text-text-secondary px-3 py-2 rounded-lg text-xs hover:text-text-primary transition-colors'
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
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

      {/* List */}
      {keys.length === 0 ? (
        <div className='flex flex-col items-center gap-2 text-text-muted text-center mt-10 text-sm'>
          <KeyRound size={20} className='opacity-60' />
          No API keys yet
        </div>
      ) : (
        <div className='flex flex-col gap-2'>
          {keys.map((k) => (
            <div
              key={k.id}
              className='bg-surface border border-border rounded-lg px-4 py-3 flex items-center gap-3'
            >
              <div className='flex-1 min-w-0'>
                <div className='font-medium text-sm truncate'>{k.name}</div>
                <div className='text-xs text-text-muted font-mono truncate'>
                  {k.prefix} · created {when(k.created_at)} · last used {when(k.last_used_at)}
                </div>
              </div>
              {confirming === k.id ? (
                <div className='flex gap-2 items-center shrink-0'>
                  <button
                    onClick={() => revoke(k.id)}
                    className='text-xs text-danger hover:opacity-80 transition-opacity'
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    className='text-xs text-text-muted hover:text-text-primary transition-colors'
                  >
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
        </div>
      )}
    </div>
  )
}
