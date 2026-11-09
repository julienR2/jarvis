import { mkdirSync, readFileSync, renameSync, watchFile, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * secrets.json, and the much smaller copy of it the engine is given.
 *
 * secrets.json holds everything: the JWT signing key, the setup code, the
 * Claude OAuth token, gateway and One keys. It lives in `agent/data/`, which
 * only the backend mounts — the engine, where the agent's shell runs, has that
 * directory hidden behind an empty tmpfs.
 *
 * The engine still needs four values to run the agent: the internal secret (to
 * check the backend's calls, and for the agent's own calls to /internal), the
 * Claude OAuth token, the gateway URL and key, and the One key. Every one of
 * those ends up in the agent's environment or in a child process's anyway, so
 * the agent can already read them; mirroring exactly those, and nothing else,
 * gives the engine what it needs without handing over the rest.
 *
 * The mirror is a file in a directory of its own (`agent/data/engine/`), which
 * compose mounts read-only into the engine. A directory rather than the file,
 * because the write below is a rename and a file bind mount would stay pinned
 * to the old inode.
 */

export const SECRETS_PATH = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'
export const ENGINE_CREDENTIALS_PATH =
  process.env.ENGINE_CREDENTIALS_PATH || join(dirname(SECRETS_PATH), 'engine', 'credentials.json')

export function readSecrets(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

export function writeSecrets(secrets: Record<string, unknown>): void {
  writeJsonAtomic(SECRETS_PATH, secrets)
  syncEngineCredentials()
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * Rewrite the engine's copy. Values are resolved the way the engine used to
 * resolve them for itself — environment first where it did that — because the
 * engine no longer receives the backend's `.env`.
 */
export function syncEngineCredentials(): void {
  const s = readSecrets()
  const creds: Record<string, unknown> = {
    internal: process.env.INTERNAL_SECRET || str(s.internal),
    claudeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || str(s.claudeOauthToken),
    providerBaseUrl: str(s.providerBaseUrl) || process.env.ANTHROPIC_BASE_URL,
    providerAuthToken: str(s.providerAuthToken) || process.env.ANTHROPIC_AUTH_TOKEN,
    oneApiKey: str(s.oneApiKey),
    oneEnabled: s.oneEnabled !== false,
  }
  for (const k of Object.keys(creds)) if (creds[k] === undefined) delete creds[k]
  let current = ''
  try {
    current = readFileSync(ENGINE_CREDENTIALS_PATH, 'utf8')
  } catch { /* first write */ }
  if (current === JSON.stringify(creds, null, 2)) return
  try {
    writeJsonAtomic(ENGINE_CREDENTIALS_PATH, creds)
  } catch (err) {
    console.error('[secrets] could not write the engine credentials:', err)
  }
}

/**
 * Keep the mirror current when secrets.json is edited by hand on the host.
 * Polling, because inotify does not see through every bind mount.
 */
export function watchSecrets(): void {
  syncEngineCredentials()
  watchFile(SECRETS_PATH, { interval: 2000 }, () => syncEngineCredentials())
}
