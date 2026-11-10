import { randomBytes } from 'crypto'
import { readSecrets, writeSecrets } from './secrets.js'

const DEFAULT_JWT_PLACEHOLDER = 'change-me-in-production'
const DEFAULT_INTERNAL_PLACEHOLDER = 'internal'

function loadOrGenerateSecrets(): { jwt: string; internal: string } {
  const stored = readSecrets() as Partial<{ jwt: string; internal: string }>

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

  // Set before writing: the engine's mirror (see secrets.ts) reads the
  // effective internal secret from here.
  process.env.JWT_SECRET = jwt
  process.env.INTERNAL_SECRET = internal

  if (stored.jwt !== jwt || stored.internal !== internal) {
    // Merged, not replaced: the file also holds the OAuth token, gateway and
    // One keys, and the setup code.
    writeSecrets({ ...stored, jwt, internal })
    console.log('[config] Secrets persisted')
  }

  return { jwt, internal }
}

const secrets = loadOrGenerateSecrets()

// How many reverse-proxy hops to trust when resolving the client IP from
// X-Forwarded-For (rate limiting keys on it). Default 1: the shipped stack puts
// one XFF-writing proxy (nginx / Traefik / Coolify) in front; the vite preview
// proxy in between forwards headers without appending. Set TRUST_PROXY=false if
// clients hit the backend directly, or a number/address list for deeper chains.
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === '') return 1
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  return Number.isInteger(n) ? n : raw
}

export const config = {
  port: parseInt(process.env.PORT || '3005'),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  jwtSecret: secrets.jwt,
  internalSecret: secrets.internal,
  dbPath: process.env.DB_PATH || '/jarvis/agent/data/jarvis.db',
  workspaceDir: process.env.WORKSPACE_DIR || '/jarvis/agent/workspace',
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || '/jarvis/agent',
  sttUrl: process.env.STT_URL || 'http://stt:9000',
  // URL that external containers (engine / claude) use to reach us.
  // Baked into prompts and skills so claude's curl calls resolve.
  internalUrl: process.env.BACKEND_URL || 'http://backend:3005',
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  tz: process.env.TZ || 'UTC',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
} as const
