// Marketplace + plugin management, wrapping the `claude plugin` CLI.
//
// This lives in the engine, not the backend, for two reasons: the `claude`
// binary is only installed here, and CLAUDE_CONFIG_DIR (where the CLI writes
// `settings.json`'s extraKnownMarketplaces/enabledPlugins and the plugin cache)
// is this container's config dir. Every operation shells out — hand-editing
// that JSON would skip the git clone, manifest validation and cache layout the
// CLI owns.
//
// Installs go to the *user* scope, so an enabled plugin is active in every
// conversation Jarvis spawns, for good. Warm sessions are the one exception:
// a `claude` process reads plugins at spawn, so after any mutation we recycle
// the idle ones (see recycleIdleSessions) — they respawn with --resume on the
// next message, keeping their context but picking up the new plugin set.

import { execFile } from 'child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import type { FastifyInstance } from 'fastify'
import { claudeOauthToken } from './shared.js'
import { recycleIdleSessions } from './sessions.js'

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || '/jarvis/agent'
// Marketplace add / plugin install clone git repos; the CLI's own clone
// timeout is 120s, so leave headroom above it.
const CLI_TIMEOUT_MS = 180_000

// ── Types ────────────────────────────────────────────────────────────────────

export interface Marketplace {
  name: string
  /** 'github' | 'git' | 'local' | … — whatever the CLI reports. */
  source: string
  repo?: string
  url?: string
  path?: string
  installLocation?: string
}

export interface InstalledPlugin {
  id: string
  /** Display half of the id: `code-review` in `code-review@claude-code-plugins`. */
  name: string
  marketplace: string
  description?: string
  version?: string
  scope?: string
  enabled: boolean
  installedAt?: string
  lastUpdated?: string
  /**
   * Whether this plugin reads an always-on flag file at all (see
   * supportsAlwaysOn). False for the majority — their components are simply
   * available, and the model or the user decides when to fire them.
   */
  alwaysOnSupported: boolean
  /** The flag file exists, so the plugin forces itself on in every session. */
  alwaysOn: boolean
}

export interface AvailablePlugin {
  pluginId: string
  name: string
  description?: string
  marketplaceName: string
  version?: string
}

export interface PluginState {
  marketplaces: Marketplace[]
  installed: InstalledPlugin[]
  available: AvailablePlugin[]
}

// ── CLI plumbing ─────────────────────────────────────────────────────────────

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '')

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['plugin', ...args],
      {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: CONFIG_DIR,
          ...(claudeOauthToken()
            ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken() }
            : {}),
        },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stripAnsi(stdout))
        // The CLI reports failures on stderr, sometimes as several lines of git
        // output. Keep the tail — that's where the actual cause is; stdout goes
        // first so its progress chatter ("Adding marketplace…") never wins.
        const detail = stripAnsi(`${stdout}\n${stderr}`)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-4)
          .join(' — ')
        reject(new Error(detail || err.message))
      },
    )
  })
}

// Mutations write settings.json and the plugin cache; two concurrent CLI runs
// would race on both. Reads stay off the queue.
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

// ── Reads ────────────────────────────────────────────────────────────────────

function parseJson<T>(raw: string, fallback: T): T {
  // The CLI prefixes progress lines ("Refreshing marketplace cache…") before
  // the JSON payload on some commands — start at the first bracket.
  const start = raw.search(/[[{]/)
  if (start < 0) return fallback
  try {
    return JSON.parse(raw.slice(start)) as T
  } catch {
    return fallback
  }
}

/**
 * `plugin list --json` only reports ids, so pull name + description out of each
 * marketplace's manifest to give installed plugins the same card as available
 * ones.
 */
function manifestIndex(
  marketplaces: Marketplace[],
): Map<string, { description?: string; version?: string }> {
  const index = new Map<string, { description?: string; version?: string }>()
  for (const mp of marketplaces) {
    if (!mp.installLocation) continue
    try {
      const manifest = JSON.parse(
        readFileSync(
          `${mp.installLocation}/.claude-plugin/marketplace.json`,
          'utf8',
        ),
      )
      for (const p of manifest.plugins ?? []) {
        index.set(`${p.name}@${mp.name}`, {
          description: p.description,
          version: p.version,
        })
      }
    } catch {
      // Manifest missing or unreadable (marketplace removed under us) — the
      // plugin still lists fine, just without its blurb.
    }
  }
  return index
}

// ── Always-on ────────────────────────────────────────────────────────────────
//
// Some plugins ship a SessionStart hook that injects their whole ruleset into
// every session, but keep it behind an opt-in flag file in CLAUDE_CONFIG_DIR,
// named `.<plugin-name>-always`. Installing such a plugin therefore does
// nothing visible until that file exists, which is invisible from the CLI.
//
// The flag name is derived from the plugin name, so we can drive it. We only
// offer the switch when the plugin's own files actually mention that path —
// otherwise the toggle would write a file nothing ever reads.

const alwaysOnFlag = (name: string): string => join(CONFIG_DIR, `.${name}-always`)

const SCAN_SKIP = new Set(['.git', 'node_modules', 'tests', 'evals'])
const SCAN_MAX_FILES = 400
const SCAN_MAX_BYTES = 256 * 1024

/** Does anything the plugin ships read `.<name>-always`? */
function supportsAlwaysOn(installPath: string | undefined, name: string): boolean {
  if (!installPath || !existsSync(installPath)) return false
  const needle = `.${name}-always`
  let budget = SCAN_MAX_FILES

  const walk = (dir: string): boolean => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return false
    }
    for (const entry of entries) {
      if (budget <= 0) return false
      if (SCAN_SKIP.has(entry)) continue
      const full = join(dir, entry)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (walk(full)) return true
        continue
      }
      budget--
      if (info.size > SCAN_MAX_BYTES) continue
      try {
        if (readFileSync(full, 'utf8').includes(needle)) return true
      } catch {
        // Binary or unreadable — nothing to match.
      }
    }
    return false
  }

  return walk(installPath)
}

export async function getState(): Promise<PluginState> {
  const marketplaces = parseJson<Marketplace[]>(
    await runCli(['marketplace', 'list', '--json']),
    [],
  )
  // --available needs --json and returns both halves in one call.
  const listed = parseJson<{ installed?: any[]; available?: AvailablePlugin[] }>(
    await runCli(['list', '--available', '--json']),
    {},
  )
  const meta = manifestIndex(marketplaces)

  const installed: InstalledPlugin[] = (listed.installed ?? []).map((p) => {
    const [name, marketplace = ''] = String(p.id).split('@')
    return {
      id: p.id,
      name,
      marketplace,
      description: meta.get(p.id)?.description,
      version: p.version ?? meta.get(p.id)?.version,
      scope: p.scope,
      // Absent means enabled — only an explicit disable writes the flag.
      enabled: p.enabled !== false,
      installedAt: p.installedAt,
      lastUpdated: p.lastUpdated,
      alwaysOnSupported: supportsAlwaysOn(p.installPath, name),
      alwaysOn: existsSync(alwaysOnFlag(name)),
    }
  })

  return { marketplaces, installed, available: listed.available ?? [] }
}

/** Free-text component inventory + token cost for one installed plugin. */
export async function getDetails(pluginId: string): Promise<string> {
  return (await runCli(['details', pluginId])).trim()
}

// ── Mutations ────────────────────────────────────────────────────────────────

export interface MutationResult extends PluginState {
  /** CLI stdout, shown as the success line in the UI. */
  message: string
  /** Conversations whose warm session was recycled to pick the change up. */
  recycled: string[]
  /** Conversations mid-turn, which keep the old plugin set until they finish. */
  busy: string[]
}

/**
 * Run one change, then recycle idle sessions and report the fresh state. Shared
 * by the CLI-backed operations and the always-on flag, which is a plain file.
 */
async function apply(change: () => Promise<string>): Promise<MutationResult> {
  return serialize(async () => {
    const out = await change()
    const { recycled, busy } = recycleIdleSessions()
    return {
      ...(await getState()),
      message: stripAnsi(out)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() ?? 'Done',
      recycled,
      busy,
    }
  })
}

const mutate = (args: string[]): Promise<MutationResult> => apply(() => runCli(args))

export const addMarketplace = (source: string) =>
  mutate(['marketplace', 'add', source])

export const updateMarketplace = (name: string) =>
  mutate(['marketplace', 'update', name])

export const removeMarketplace = (name: string) =>
  mutate(['marketplace', 'remove', name])

export const installPlugin = (pluginId: string) =>
  mutate(['install', pluginId, '--scope', 'user'])

// -y: the CLI refuses the prune prompt without a TTY. We never prune, but the
// flag costs nothing and guards against a future default change.
export const uninstallPlugin = (pluginId: string) =>
  mutate(['uninstall', pluginId, '--scope', 'user', '-y'])

export const setPluginEnabled = (pluginId: string, enabled: boolean) =>
  mutate([enabled ? 'enable' : 'disable', pluginId, '--scope', 'user'])

/**
 * Create or delete the plugin's always-on flag file. Refuses plugins that never
 * read one, so the switch can't silently do nothing.
 */
export function setPluginAlwaysOn(
  pluginId: string,
  alwaysOn: boolean,
): Promise<MutationResult> {
  return apply(async () => {
    const name = pluginId.split('@')[0]
    const state = await getState()
    const plugin = state.installed.find((p) => p.id === pluginId)
    if (!plugin) throw new Error(`Plugin "${pluginId}" is not installed`)
    if (!plugin.alwaysOnSupported) {
      throw new Error(`Plugin "${name}" has no always-on mode`)
    }

    const flag = alwaysOnFlag(name)
    if (alwaysOn) {
      writeFileSync(
        flag,
        `Created by Jarvis (Settings -> Plugins) to force ${name} on in every session.\n`,
      )
      return `${name} is now always on — it loads in every new session`
    }
    rmSync(flag, { force: true })
    return `${name} is no longer always on — it stays installed and enabled`
  })
}

export const updatePlugin = (pluginId: string) => mutate(['update', pluginId])

// ── Routes ───────────────────────────────────────────────────────────────────

export function registerPluginRoutes(app: FastifyInstance): void {
  const fail = (reply: any, err: unknown) =>
    reply.code(400).send({ error: (err as Error)?.message ?? 'Plugin command failed' })

  app.get('/plugins', async (_req, reply) => {
    try {
      return await getState()
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Body: { source?: string } }>(
    '/plugins/marketplaces',
    async (req, reply) => {
      const source = req.body?.source?.trim()
      if (!source) return reply.code(400).send({ error: 'source is required' })
      try {
        return await addMarketplace(source)
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  app.post<{ Params: { name: string } }>(
    '/plugins/marketplaces/:name/update',
    async (req, reply) => {
      try {
        return await updateMarketplace(req.params.name)
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  app.delete<{ Params: { name: string } }>(
    '/plugins/marketplaces/:name',
    async (req, reply) => {
      try {
        return await removeMarketplace(req.params.name)
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  app.post<{ Body: { pluginId?: string } }>(
    '/plugins/install',
    async (req, reply) => {
      const pluginId = req.body?.pluginId?.trim()
      if (!pluginId) return reply.code(400).send({ error: 'pluginId is required' })
      try {
        return await installPlugin(pluginId)
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  app.post<{ Params: { pluginId: string }; Body: { enabled?: boolean } }>(
    '/plugins/:pluginId/enabled',
    async (req, reply) => {
      try {
        return await setPluginEnabled(req.params.pluginId, req.body?.enabled !== false)
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  app.post<{ Params: { pluginId: string }; Body: { alwaysOn?: boolean } }>(
    '/plugins/:pluginId/always-on',
    async (req, reply) => {
      try {
        return await setPluginAlwaysOn(req.params.pluginId, req.body?.alwaysOn !== false)
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  app.post<{ Params: { pluginId: string } }>(
    '/plugins/:pluginId/update',
    async (req, reply) => {
      try {
        return await updatePlugin(req.params.pluginId)
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  app.get<{ Params: { pluginId: string } }>(
    '/plugins/:pluginId/details',
    async (req, reply) => {
      try {
        return { details: await getDetails(req.params.pluginId) }
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  app.delete<{ Params: { pluginId: string } }>(
    '/plugins/:pluginId',
    async (req, reply) => {
      try {
        return await uninstallPlugin(req.params.pluginId)
      } catch (err) {
        return fail(reply, err)
      }
    },
  )
}
