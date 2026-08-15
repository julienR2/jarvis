import { useState, useEffect } from 'react'
import {
  Blocks,
  Store,
  Plus,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
} from 'lucide-react'
import {
  api,
  type PluginState,
  type PluginMutation,
  type Marketplace,
  type InstalledPlugin,
  type AvailablePlugin,
} from '../api'
import ContentLayout from './ContentLayout'

const EMPTY: PluginState = { marketplaces: [], installed: [], available: [] }

/** `github: anthropics/claude-code`, `local: /path/to/repo`, … */
function sourceLabel(mp: Marketplace): string {
  const target = mp.repo ?? mp.url ?? mp.path ?? ''
  return target ? `${mp.source}: ${target}` : mp.source
}

export default function PluginsPage() {
  const [state, setState] = useState<PluginState>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [source, setSource] = useState('')
  const [filter, setFilter] = useState('')

  async function load() {
    setLoading(true)
    try {
      setState(await api.getPlugins())
      setError('')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  /**
   * Every mutation returns the refreshed state, so one call both performs the
   * action and repaints the page. `key` identifies which row is spinning.
   */
  async function run(key: string, action: () => Promise<PluginMutation>): Promise<boolean> {
    setBusy(key)
    setError('')
    setStatus('')
    try {
      const res = await action()
      setState({
        marketplaces: res.marketplaces,
        installed: res.installed,
        available: res.available,
      })
      const recycled = res.recycled.length
        ? ` ${res.recycled.length} chat${res.recycled.length > 1 ? 's' : ''} will pick it up on the next message.`
        : ''
      const stuck = res.busy.length
        ? ` ${res.busy.length} chat${res.busy.length > 1 ? 's' : ''} mid-answer will keep the old set until the turn ends.`
        : ''
      setStatus(res.message + recycled + stuck)
      return true
    } catch (err: any) {
      setError(err.message)
      return false
    } finally {
      setBusy(null)
    }
  }

  /**
   * Move a plugin to one of the three states. Always-on lives in a different
   * place from enabled (a flag file vs the CLI's settings), so some moves take
   * two calls — the segmented control hides that.
   */
  async function setMode(plugin: InstalledPlugin, mode: PluginMode) {
    const key = `p-${plugin.id}`
    if (mode === 'disabled') {
      await run(key, () => api.setPluginEnabled(plugin.id, false))
      return
    }
    if (!plugin.enabled && !(await run(key, () => api.setPluginEnabled(plugin.id, true)))) {
      return
    }
    // Re-assert the flag only when it disagrees: enabling a plugin whose flag
    // was left behind must not silently resurrect always-on.
    const wantAlways = mode === 'always'
    if (plugin.alwaysOnSupported && plugin.alwaysOn !== wantAlways) {
      await run(key, () => api.setPluginAlwaysOn(plugin.id, wantAlways))
    }
  }

  // Keep the typed source on failure so a typo can be corrected in place.
  async function addMarketplace() {
    if (await run('add-marketplace', () => api.addMarketplace(source.trim()))) {
      setSource('')
    }
  }

  const q = filter.trim().toLowerCase()
  const available = q
    ? state.available.filter((p) =>
        `${p.name} ${p.description ?? ''} ${p.marketplaceName}`.toLowerCase().includes(q),
      )
    : state.available

  return (
    <ContentLayout title='Plugins'>
      <p className='text-text-muted text-sm mb-6'>
        Claude Code plugins — skills, agents, commands and hooks packaged
        together. Marketplaces are the catalogues you install them from.
        Everything installs at user scope, so <strong>Enabled</strong> means the
        plugin's components are available to every conversation, cron and
        webhook — available, but only used when something calls them.{' '}
        <strong>Always on</strong> also sets the plugin's own opt-in flag, so it
        injects itself into every session unasked. A few plugins do nothing at
        all until you switch that on.
      </p>

      {error && (
        <div className='bg-danger/10 border border-danger/30 text-danger text-xs rounded-lg px-3 py-2 mb-4 whitespace-pre-wrap'>
          {error}
        </div>
      )}
      {status && (
        <div className='bg-surface border border-border text-text-secondary text-xs rounded-lg px-3 py-2 mb-4'>
          {status}
        </div>
      )}

      {/* ── Marketplaces ─────────────────────────────────────────────────── */}
      <section className='mb-8'>
        <h2 className='flex items-center gap-2 text-sm font-medium mb-3'>
          <Store size={15} className='text-text-muted' />
          Marketplaces
        </h2>

        <div className='flex gap-2 mb-3'>
          <input
            placeholder='owner/repo, a git URL, or a local path'
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && source.trim() && !busy) addMarketplace()
            }}
            className='flex-1 bg-surface2 border border-border text-text-primary rounded-lg px-3 py-2 text-sm font-mono focus:border-accent'
          />
          <button
            onClick={addMarketplace}
            disabled={!source.trim() || busy !== null}
            className='bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors flex items-center gap-1.5'
          >
            {busy === 'add-marketplace' ? (
              <Loader2 size={14} className='animate-spin' />
            ) : (
              <Plus size={14} />
            )}
            Add
          </button>
        </div>

        {loading ? (
          <div className='text-text-muted text-sm'>Loading…</div>
        ) : state.marketplaces.length === 0 ? (
          <div className='text-text-muted text-sm'>
            No marketplace yet. Try{' '}
            <code className='font-mono text-text-secondary'>anthropics/claude-code</code>{' '}
            for the official one.
          </div>
        ) : (
          <div className='flex flex-col gap-2'>
            {state.marketplaces.map((mp) => (
              <div
                key={mp.name}
                className='bg-surface border border-border rounded-lg px-4 py-3 flex items-center gap-3'
              >
                <div className='flex-1 min-w-0'>
                  <div className='font-medium text-sm truncate'>{mp.name}</div>
                  <div className='text-xs text-text-muted font-mono truncate'>
                    {sourceLabel(mp)}
                  </div>
                </div>
                <button
                  onClick={() => run(`mp-${mp.name}`, () => api.updateMarketplace(mp.name))}
                  disabled={busy !== null}
                  title='Pull the latest catalogue'
                  className='text-text-muted hover:text-text-primary transition-colors disabled:opacity-40'
                >
                  {busy === `mp-${mp.name}` ? (
                    <Loader2 size={15} className='animate-spin' />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                </button>
                <button
                  onClick={() => {
                    if (
                      confirm(
                        `Remove marketplace "${mp.name}"? Plugins installed from it stop loading.`,
                      )
                    ) {
                      run(`mp-${mp.name}`, () => api.removeMarketplace(mp.name))
                    }
                  }}
                  disabled={busy !== null}
                  title='Remove marketplace'
                  className='text-text-muted hover:text-danger transition-colors disabled:opacity-40'
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Installed ────────────────────────────────────────────────────── */}
      <section className='mb-8'>
        <h2 className='flex items-center gap-2 text-sm font-medium mb-3'>
          <Blocks size={15} className='text-text-muted' />
          Installed
          {state.installed.length > 0 && (
            <span className='text-text-muted font-normal'>({state.installed.length})</span>
          )}
        </h2>

        {state.installed.length === 0 ? (
          <div className='text-text-muted text-sm'>
            Nothing installed. Pick one from the catalogue below.
          </div>
        ) : (
          <div className='flex flex-col gap-2'>
            {state.installed.map((p) => (
              <InstalledRow
                key={p.id}
                plugin={p}
                busy={busy}
                onSetMode={(mode) => setMode(p, mode)}
                onUpdate={() => run(`p-${p.id}`, () => api.updatePlugin(p.id))}
                onUninstall={() => {
                  if (confirm(`Uninstall "${p.name}"?`)) {
                    run(`p-${p.id}`, () => api.uninstallPlugin(p.id))
                  }
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Available ────────────────────────────────────────────────────── */}
      <section>
        <div className='flex items-center gap-2 mb-3'>
          <h2 className='flex items-center gap-2 text-sm font-medium'>
            <Search size={15} className='text-text-muted' />
            Catalogue
          </h2>
          {state.available.length > 0 && (
            <input
              placeholder='Filter…'
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className='ml-auto bg-surface2 border border-border text-text-primary rounded-lg px-3 py-1.5 text-xs w-40 focus:border-accent'
            />
          )}
        </div>

        {state.available.length === 0 ? (
          <div className='text-text-muted text-sm'>
            {state.marketplaces.length === 0
              ? 'Add a marketplace to see what it offers.'
              : 'Everything on offer is already installed.'}
          </div>
        ) : (
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-2'>
            {available.map((p) => (
              <AvailableCard
                key={p.pluginId}
                plugin={p}
                busy={busy}
                onInstall={() => run(`p-${p.pluginId}`, () => api.installPlugin(p.pluginId))}
              />
            ))}
          </div>
        )}
      </section>
    </ContentLayout>
  )
}

// ── Installed row ────────────────────────────────────────────────────────────

/** The three states a plugin can be in, in increasing order of pushiness. */
export type PluginMode = 'disabled' | 'enabled' | 'always'

const MODE_HELP: Record<PluginMode, string> = {
  disabled: 'Not loaded at all',
  enabled: 'Available everywhere, used when something calls it',
  always: 'Injects itself into every session — chats, crons, webhooks',
}

function InstalledRow({
  plugin,
  busy,
  onSetMode,
  onUpdate,
  onUninstall,
}: {
  plugin: InstalledPlugin
  busy: string | null
  onSetMode: (mode: PluginMode) => void
  onUpdate: () => void
  onUninstall: () => void
}) {
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState<string | null>(null)

  // Loaded lazily: `plugin details` reads the plugin's whole component tree.
  async function expand() {
    setOpen((o) => !o)
    if (details === null) {
      try {
        setDetails((await api.getPluginDetails(plugin.id)).details)
      } catch (err: any) {
        setDetails(err.message)
      }
    }
  }

  const rowBusy = busy === `p-${plugin.id}`
  // The row's single source of truth. Always-on implies enabled, so the states
  // are ordered, not independent — which is why they're one control and not a
  // badge plus a switch that could disagree with each other.
  const mode: PluginMode = !plugin.enabled
    ? 'disabled'
    : plugin.alwaysOn
      ? 'always'
      : 'enabled'

  const modes: PluginMode[] = plugin.alwaysOnSupported
    ? ['disabled', 'enabled', 'always']
    : ['disabled', 'enabled']

  return (
    <div
      className={`bg-surface border border-border rounded-lg px-4 py-3 ${
        plugin.enabled ? '' : 'opacity-60'
      }`}
    >
      {/* Header: identity on the left, destructive-ish actions on the right */}
      <div className='flex items-start gap-2'>
        <button
          onClick={expand}
          className='text-text-muted hover:text-text-primary transition-colors shrink-0 mt-0.5'
          title='Component inventory'
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>

        <div className='flex-1 min-w-0'>
          <div className='flex items-baseline gap-2'>
            <span className='font-medium text-sm truncate'>{plugin.name}</span>
            {plugin.version && (
              <span className='text-[10px] text-text-muted font-mono shrink-0'>
                v{plugin.version}
              </span>
            )}
          </div>
          <div className='text-xs text-text-muted line-clamp-2'>
            {plugin.description || plugin.marketplace}
          </div>
        </div>

        <div className='flex items-center gap-3 shrink-0'>
          <button
            onClick={onUpdate}
            disabled={busy !== null}
            title='Update to the latest version'
            className='text-text-muted hover:text-text-primary transition-colors disabled:opacity-40'
          >
            <RefreshCw size={15} />
          </button>
          <button
            onClick={onUninstall}
            disabled={busy !== null}
            title='Uninstall'
            className='text-text-muted hover:text-danger transition-colors disabled:opacity-40'
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {/* State: one segmented control, so the selected segment *is* the answer
          to "which state is this in?" */}
      <div className='flex items-center gap-2 mt-3'>
        <div className='inline-flex items-center bg-surface2 rounded-lg p-0.5 gap-0.5'>
          {modes.map((m) => (
            <button
              key={m}
              onClick={() => mode !== m && onSetMode(m)}
              disabled={busy !== null}
              title={MODE_HELP[m]}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors disabled:opacity-50 ${
                mode === m
                  ? m === 'disabled'
                    ? 'bg-surface text-text-secondary font-medium'
                    : 'bg-accent text-white font-medium'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {m === 'disabled' ? 'Disabled' : m === 'enabled' ? 'Enabled' : 'Always on'}
            </button>
          ))}
        </div>
        {rowBusy && <Loader2 size={14} className='animate-spin text-text-muted' />}
      </div>

      {open && (
        <pre className='mt-3 text-[11px] leading-relaxed text-text-muted font-mono whitespace-pre-wrap border-t border-border pt-3'>
          {details ?? 'Loading…'}
        </pre>
      )}
    </div>
  )
}

// ── Available card ───────────────────────────────────────────────────────────

function AvailableCard({
  plugin,
  busy,
  onInstall,
}: {
  plugin: AvailablePlugin
  busy: string | null
  onInstall: () => void
}) {
  return (
    <div className='bg-surface border border-border rounded-lg px-4 py-3 flex flex-col gap-2'>
      <div className='flex items-start gap-2'>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2'>
            <span className='font-medium text-sm truncate'>{plugin.name}</span>
            {plugin.version && (
              <span className='text-[10px] text-text-muted font-mono'>v{plugin.version}</span>
            )}
          </div>
          <div className='text-[10px] text-text-muted font-mono'>{plugin.marketplaceName}</div>
        </div>
        <button
          onClick={onInstall}
          disabled={busy !== null}
          className='shrink-0 text-xs text-accent hover:opacity-80 transition-opacity disabled:opacity-40 flex items-center gap-1'
        >
          {busy === `p-${plugin.pluginId}` ? (
            <Loader2 size={13} className='animate-spin' />
          ) : (
            <Plus size={13} />
          )}
          Install
        </button>
      </div>
      {plugin.description && (
        <p className='text-xs text-text-muted line-clamp-3'>{plugin.description}</p>
      )}
    </div>
  )
}
