import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, type Cron, type CronInput } from '../api'
import ContentLayout from './ContentLayout'
import ModelSelector, { MODELS } from './ModelSelector'

const EMPTY: CronInput = {
  name: '',
  schedule: '',
  prompt: '',
  enabled: true,
  once: false,
  model: 'claude-sonnet-4-6',
  thinking: false,
}

export default function CronManager() {
  const [crons, setCrons] = useState<Cron[]>([])
  const [form, setForm] = useState<CronInput>(EMPTY)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const filterConvId = searchParams.get('conversation_id')

  async function load() {
    setCrons(await api.getCrons())
  }

  useEffect(() => {
    load()
  }, [])

  async function save() {
    setError('')
    try {
      if (editing) {
        await api.updateCron(editing, form)
      } else {
        await api.createCron(form)
      }
      setForm(EMPTY)
      setEditing(null)
      load()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function toggle(cron: Cron) {
    await api.updateCron(cron.id, { enabled: !cron.enabled })
    load()
  }

  async function trigger(id: string) {
    await api.triggerCron(id)
    load()
  }

  async function remove(id: string) {
    await api.deleteCron(id)
    load()
  }

  function edit(cron: Cron) {
    setEditing(cron.id)
    setForm({
      name: cron.name,
      schedule: cron.schedule,
      prompt: cron.prompt,
      enabled: !!cron.enabled,
      once: !!cron.once,
      model: cron.model ?? 'claude-sonnet-4-6',
      thinking: !!cron.thinking,
    })
  }

  const displayed = filterConvId
    ? crons.filter((c) => c.conversation_id === filterConvId)
    : crons

  return (
    <ContentLayout title='Crons'>
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
      {/* Form */}
      <div className='bg-surface border border-border rounded-xl p-5 mb-6 flex flex-col gap-3'>
        <h3 className='font-medium text-sm'>
          {editing ? 'Edit cron' : 'New cron'}
        </h3>

        {error && <div className='text-danger text-xs'>{error}</div>}

        <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
          <input
            placeholder='Name (e.g. daily-brief)'
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className='bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm focus:border-accent'
          />
          <input
            placeholder='Schedule (e.g. 0 7 * * *)'
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            className='bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm font-mono focus:border-accent'
          />
        </div>

        <textarea
          placeholder='Prompt sent to the agent'
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
            <label className='flex gap-1.5 items-center cursor-pointer text-text-muted'>
              <input
                type='checkbox'
                checked={form.once}
                onChange={(e) => setForm({ ...form, once: e.target.checked })}
                className='accent-accent'
              />
              Run once
            </label>

            <ModelSelector
              model={form.model ?? 'claude-sonnet-4-6'}
              thinking={form.thinking ?? true}
              onModelChange={(m) => setForm({ ...form, model: m })}
              onThinkingChange={(t) => setForm({ ...form, thinking: t })}
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
              disabled={!form.name || !form.schedule || !form.prompt}
              className='bg-accent text-white px-4 py-2 rounded-lg font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors'
            >
              {editing ? 'Update' : 'Create'}
            </button>
          </div>
        </div>
      </div>

      {/* List */}
      {crons.length === 0 && (
        <div className='text-text-muted text-center mt-8 text-sm'>
          No crons yet
        </div>
      )}
      <div className='flex flex-col gap-2'>
        {displayed.map((cron) => (
          <div
            key={cron.id}
            className={`
              bg-surface border border-border rounded-lg px-4 py-3 flex items-center gap-3
              ${cron.enabled ? '' : 'opacity-50'}
            `}
          >
            <div className='flex-1 min-w-0'>
              <div className='font-medium text-sm'>{cron.name}</div>
              <div className='text-xs text-text-muted font-mono'>
                {cron.schedule}
                {cron.once ? ' \u00B7 once' : ''}
                {' \u00B7 '}{MODELS.find(m => m.id === cron.model)?.name ?? 'Opus 4.6'}
                {cron.thinking ? ' Extended' : ''}
                {cron.last_run
                  ? ` \u00B7 last: ${new Date(cron.last_run * 1000).toLocaleString('fr-FR')}`
                  : ''}
              </div>
              <div className='text-xs text-text-muted mt-1 overflow-hidden text-ellipsis whitespace-nowrap'>
                {cron.prompt}
              </div>
            </div>
            <button
              onClick={() => toggle(cron)}
              title={cron.enabled ? 'Disable' : 'Enable'}
              className='text-lg opacity-70 hover:opacity-100 transition-opacity'
            >
              {cron.enabled ? '\u23F8' : '\u25B6\uFE0F'}
            </button>
            <button
              onClick={() => trigger(cron.id)}
              title='Fire now'
              className='text-xs text-accent hover:opacity-80 transition-opacity'
            >
              Fire
            </button>
            {cron.conversation_id && (
              <button
                onClick={() => navigate(`/c/${cron.conversation_id}`)}
                className='text-xs text-accent hover:opacity-80 transition-opacity'
              >
                View
              </button>
            )}
            <button
              onClick={() => edit(cron)}
              className='text-xs text-text-muted hover:text-text-primary transition-colors'
            >
              Edit
            </button>
            <button
              onClick={() => remove(cron.id)}
              className='text-xs text-danger hover:opacity-80 transition-opacity'
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </ContentLayout>
  )
}
