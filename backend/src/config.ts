import { randomBytes } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

const DEFAULT_JWT_PLACEHOLDER = 'change-me-in-production'
const DEFAULT_INTERNAL_PLACEHOLDER = 'internal'

const secretsPath = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'

function loadOrGenerateSecrets(): { jwt: string; internal: string } {
  let stored: Partial<{ jwt: string; internal: string }> = {}
  try {
    stored = JSON.parse(readFileSync(secretsPath, 'utf8'))
  } catch { /* first boot — no file yet */ }

  const envJwt = process.env.JWT_SECRET
  const envInternal = process.env.INTERNAL_SECRET

  const jwt =
    (envJwt && envJwt !== DEFAULT_JWT_PLACEHOLDER ? envJwt : undefined) ??
    stored.jwt ??
    randomBytes(32).toString('hex')

  const internal =
    (envInternal && envInternal !== DEFAULT_INTERNAL_PLACEHOLDER ? envInternal : undefined) ??
    stored.internal ??
    randomBytes(32).toString('hex')

  if (stored.jwt !== jwt || stored.internal !== internal) {
    mkdirSync(dirname(secretsPath), { recursive: true })
    writeFileSync(secretsPath, JSON.stringify({ jwt, internal }, null, 2), { mode: 0o600 })
    console.log(`[config] Secrets persisted to ${secretsPath}`)
  }

  // Expose so subprocesses (engine → Claude CLI) inherit the same values
  process.env.JWT_SECRET = jwt
  process.env.INTERNAL_SECRET = internal

  return { jwt, internal }
}

const secrets = loadOrGenerateSecrets()

export const config = {
  port: parseInt(process.env.PORT || '3005'),
  jwtSecret: secrets.jwt,
  internalSecret: secrets.internal,
  dbPath: process.env.DB_PATH || '/jarvis/agent/data/jarvis.db',
  workspaceDir: process.env.WORKSPACE_DIR || '/jarvis/agent/workspace',
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || '/jarvis/agent',
  whisperUrl: process.env.WHISPER_URL || 'http://whisper:9000',
  // URL that external containers (engine / claude) use to reach us.
  // Baked into prompts and skills so claude's curl calls resolve.
  internalUrl: process.env.BACKEND_URL || 'http://backend:3005',
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  tz: process.env.TZ || 'UTC',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
} as const
