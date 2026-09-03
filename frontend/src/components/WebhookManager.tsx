import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, type Webhook, type WebhookInput } from '../api'
import ContentLayout from './ContentLayout'
import ModelSelector, { getDefaultModel, DEFAULT_EFFORT, modelName } from './ModelSelector'

const EMPTY: WebhookInput = {
  name: '',
  prompt: '',
  enabled: true,
  // Left unset rather than pinned to a concrete id: the server stores that as
  // null, which means "resolve the instance default at run time" — so a cron
  // made today follows a later change of default provider instead of being
  // frozen to whatever was current when it was created.
  model: undefined,
  effort: DEFAULT_EFFORT,
}

export default function WebhookManager() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [form, setForm] = useState<WebhookInput>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const filterConvId = searchParams.get('conversation_id')

  async function load() {
    setWebhooks(await api.getWebhooks())
  }

  useEffect(() => {
    load()
  }, [])

  async function save() {
    setError('')
    try {
      if (editing) {
        await api.updateWebhook(editing, form)
      } else {
        await api.createWebhook(form)
      }
      setForm(EMPTY)
      setEditing(null)
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function toggle(webhook: Webhook) {
    await api.updateWebhook(webhook.id, { enabled: !webhook.enabled })
    load()
  }

  async function trigger(id: string) {
    await api.triggerWebhook(id)
    load()
  }

  async function remove(id: string) {
    await api.deleteWebhook(id)
    load()
  }

  function edit(webhook: Webhook) {
    setEditing(webhook.id)
    setForm({
      name: webhook.name,
      prompt: webhook.prompt,
      enabled: !!webhook.enabled,
      model: webhook.model ?? getDefaultModel(),
      effort: webhook.effort ?? DEFAULT_EFFORT,
    })
  }

  function copyUrl(token: string) {
    const url = `${window.location.origin}/api/hooks/${token}/trigger`
    navigator.clipboard.writeText(url)
    setCopied(token)
    setTimeout(() => setCopied(null), 2000)
  }

  const displayed = filterConvId
    ? webhooks.filter((w) => w.conversation_id === filterConvId)
    : webhooks

  return (
    <ContentLayout title='Webhooks'>
      {filterConvId && (
        <div className='flex items-center gap-2 mb-4 px-1 text-sm text-text-muted'>
          <span>Filtered by conversation</span>
          <button
            onClick={() => setSearchParams({})}
            className='text-accent hover:opacity-80 transition-opacity'
          >
            Show all
          </button>
        </div>
      )}
      {/* Info box */}
      <div className='bg-surface2/50 border border-border rounded-xl p-4 mb-6 text-xs text-text-muted'>
        <div className='font-medium text-text-secondary text-sm mb-2'>How to trigger a webhook</div>
        <p className='mb-2'>
          Send a <span className='font-mono text-text-primary'>POST</span> request to the webhook URL. The JSON body is optional and will be appended to the prompt as context.
        </p>
        <pre className='bg-bg rounded-lg p-3 overflow-x-auto text-text-secondary font-mono leading-relaxed'>
{`curl -X POST <webhook-url> \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "alice@example.com",
    "subject": "Meeting tomorrow",
    "body": "Don't forget the 10am standup..."
  }'`}
        </pre>
        <p className='mt-2'>
          No authentication needed — the token in the URL acts as the secret. Use <strong className='text-text-secondary'>Copy URL</strong> on any webhook below.
        </p>
      </div>

      {/* Form */}
      <div className='bg-surface border border-border rounded-xl p-5 mb-6 flex flex-col gap-3'>
        <h3 className='font-medium text-sm'>
          {editing ? 'Edit webhook' : 'New webhook'}
        </h3>

        {error && <div className='text-danger text-xs'>{error}</div>}

        <input
          placeholder='Name (e.g. email-processor)'
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className='bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent'
        />

        <textarea
          placeholder='Prompt sent to the agent when triggered'
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          rows={3}
          className='bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm resize-y focus:border-accent'
        />

        <div className='flex flex-wrap gap-4 items-center text-sm'>
          <div className='flex flex-wrap gap-4 items-center'>
            <label className='flex gap-1.5 items-center cursor-pointer text-text-muted'>
              <input
                type='checkbox'
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className='accent-accent'
              />
              Enabled
            </label>

            <ModelSelector
              model={form.model ?? getDefaultModel()}
              effort={form.effort ?? DEFAULT_EFFORT}
              onModelChange={(m) => setForm({ ...form, model: m })}
              onEffortChange={(e) => setForm({ ...form, effort: e })}
              direction='down'
            />
          </div>

          <div className='flex gap-2 items-center ml-auto'>
            {editing && (
              <button
                onClick={() => {
                  setEditing(null)
                  setForm(EMPTY)
                }}
                className='text-text-muted px-3 py-2 hover:text-text-primary transition-colors'
              >
                Cancel
              </button>
            )}
            <button
              onClick={save}
              disabled={!form.name || !form.prompt}
              className='bg-accent text-white px-4 py-2 rounded-lg font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors'
            >
              {editing ? 'Update' : 'Create'}
            </button>
          </div>
        </div>
      </div>

      {/* List */}
      {webhooks.length === 0 && (
        <div className='text-text-muted text-center mt-8 text-sm'>
          No webhooks yet
        </div>
      )}
      <div className='flex flex-col gap-2'>
        {displayed.map((webhook) => (
          <div
            key={webhook.id}
            className={`
              bg-surface border border-border rounded-lg px-4 py-3 flex flex-col gap-2
              ${webhook.enabled ? '' : 'opacity-50'}
            `}
          >
            <div className='flex items-center gap-3'>
              <div className='flex-1 min-w-0'>
                <div className='font-medium text-sm'>{webhook.name}</div>
                <div className='text-xs text-text-muted font-mono'>
                  {modelName(webhook.model ?? getDefaultModel())}
                  {webhook.effort && webhook.effort !== 'high' ? ` · ${webhook.effort} effort` : ''}
                  {webhook.last_run
                    ? ` \u00B7 last: ${new Date(webhook.last_run * 1000).toLocaleString('fr-FR')}`
                    : ' \u00B7 never triggered'}
                </div>
                <div className='text-xs text-text-muted mt-1 overflow-hidden text-ellipsis whitespace-nowrap'>
                  {webhook.prompt}
                </div>
              </div>
              <button
                onClick={() => toggle(webhook)}
                title={webhook.enabled ? 'Disable' : 'Enable'}
                className='text-lg opacity-70 hover:opacity-100 transition-opacity'
              >
                {webhook.enabled ? '\u23F8' : '\u25B6\uFE0F'}
              </button>
              <button
                onClick={() => trigger(webhook.id)}
                title='Fire now'
                className='text-xs text-accent hover:opacity-80 transition-opacity'
              >
                Fire
              </button>
              <button
                onClick={() => copyUrl(webhook.token)}
                title='Copy trigger URL'
                className='text-xs text-accent hover:opacity-80 transition-opacity'
              >
                {copied === webhook.token ? 'Copied!' : 'Copy URL'}
              </button>
              {webhook.conversation_id && (
                <button
                  onClick={() => navigate(`/c/${webhook.conversation_id}`)}
                  className='text-xs text-accent hover:opacity-80 transition-opacity'
                >
                  View
                </button>
              )}
              <button
                onClick={() => edit(webhook)}
                className='text-xs text-text-muted hover:text-text-primary transition-colors'
              >
                Edit
              </button>
              <button
                onClick={() => remove(webhook.id)}
                className='text-xs text-danger hover:opacity-80 transition-opacity'
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </ContentLayout>
  )
}
