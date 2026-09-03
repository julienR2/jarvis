import type { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { getDb } from '../db.js'
import { config } from '../config.js'
import { verifyConnection, recycleSessions } from '../engine.js'
import { secureEquals } from '../security.js'
import { defaultProvider, defaultModelFor, type Provider } from '../models.js'
import { extractRequestToken, SESSION_COOKIE } from '../request-auth.js'
import type { UserRow } from '../types.js'

const SECRETS_PATH = process.env.SECRETS_PATH || '/jarvis/agent/data/secrets.json'

function readSecrets(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeSecrets(secrets: Record<string, unknown>): void {
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 })
}

function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
  return row.n
}

// One-time code required to claim a fresh instance. Without it, whoever reaches
// a freshly deployed (possibly already internet-exposed) instance first becomes
// its owner. Operators can pin it via SETUP_CODE; otherwise it's generated once,
// persisted in secrets.json, and printed to the backend logs until setup is done.
function ensureSetupCode(): string {
  if (process.env.SETUP_CODE) return process.env.SETUP_CODE
  const secrets = readSecrets()
  if (typeof secrets.setupCode === 'string' && secrets.setupCode) {
    return secrets.setupCode
  }
  const code = randomBytes(6).toString('hex')
  secrets.setupCode = code
  writeSecrets(secrets)
  return code
}

function consumeSetupCode(): void {
  const secrets = readSecrets()
  if ('setupCode' in secrets) {
    delete secrets.setupCode
    writeSecrets(secrets)
  }
}

export async function authRoutes(app: FastifyInstance) {
  if (userCount() === 0) {
    const code = ensureSetupCode()
    console.log('[setup] ──────────────────────────────────────────────────')
    console.log(`[setup]  First-run setup code: ${code}`)
    console.log('[setup]  Enter it in the web UI to create the first account.')
    console.log('[setup] ──────────────────────────────────────────────────')
  }

  // GET /setup-status — public: lets the UI decide between login and first-run setup
  app.get('/setup-status', async () => {
    const needsSetup = userCount() === 0
    if (needsSetup) ensureSetupCode() // regenerated if the DB was wiped mid-run
    const secrets = readSecrets()
    const hasToken = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || secrets.claudeOauthToken)
    return { needsSetup, hasToken }
  })

  // POST /setup — public, but only works when zero users exist AND the caller
  // proves server access with the setup code from the backend logs.
  app.post('/setup', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const { email, password, setupCode } = req.body as {
      email?: string
      password?: string
      setupCode?: string
    }

    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password required' })
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters' })
    }

    const n = userCount()
    if (n > 0) {
      return reply.code(403).send({ error: 'Setup already complete' })
    }

    const expected = ensureSetupCode()
    if (!setupCode || !secureEquals(setupCode.trim(), expected)) {
      return reply.code(403).send({
        error:
          'Invalid setup code. Find it in the backend logs: docker compose logs backend | grep setup',
      })
    }

    const hash = await bcrypt.hash(password, 10)
    const result = getDb()
      .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .run(email, hash)

    consumeSetupCode()

    const token = app.jwt.sign(
      { id: result.lastInsertRowid, email },
      { expiresIn: config.jwtExpiresIn },
    )
    return { token }
  })

  app.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string }

    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password required' })
    }

    const user = getDb()
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as UserRow | undefined

    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    const token = app.jwt.sign(
      { id: user.id, email: user.email },
      { expiresIn: config.jwtExpiresIn },
    )
    return { token }
  })

  app.get('/me', { onRequest: [app.authenticate] }, async (req) => {
    const user = req.user as { id: number; email: string }
    const row = getDb().prepare('SELECT onboarded FROM users WHERE id = ?').get(user.id) as { onboarded: number } | undefined
    return { ...user, onboarded: !!(row?.onboarded) }
  })

  // POST /complete-onboarding — mark the current user as onboarded
  app.post('/complete-onboarding', { onRequest: [app.authenticate] }, async (req) => {
    const user = req.user as { id: number }
    getDb().prepare('UPDATE users SET onboarded = 1 WHERE id = ?').run(user.id)
    return { ok: true }
  })

  // POST /setup-token — save the Claude Code OAuth token
  app.post('/setup-token', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { token } = req.body as { token?: string }
    if (!token || !token.trim()) {
      return reply.code(400).send({ error: 'Token is required' })
    }

    const trimmed = token.trim()

    // Persist to secrets.json — the durable store (bind-mounted, survives
    // rebuilds), read fresh by the engine on every claude spawn. The .env
    // file is operator/infra territory; the app never writes to it.
    const secrets = readSecrets()
    secrets.claudeOauthToken = trimmed
    writeSecrets(secrets)
    await recycleSessions()

    return { ok: true }
  })

  // POST /session-cookie — mirror the caller's session into an httpOnly cookie.
  //
  // Browsers can't attach an Authorization header to `<img src>`, `<a href>` or
  // EventSource. Rather than leave those routes open (they serve uploads and
  // proxied connector content), they accept this cookie. It is set from an
  // already-authenticated request, so it grants nothing the caller didn't have.
  app.post('/session-cookie', { onRequest: [app.authenticate] }, async (req, reply) => {
    const token = extractRequestToken(req)
    if (!token) return reply.code(400).send({ error: 'No token on request' })

    const secure = req.protocol === 'https'
    reply.header(
      'Set-Cookie',
      [
        `${SESSION_COOKIE}=${token}`,
        'HttpOnly',
        // Lax, not Strict: Strict withholds the cookie on cross-site
        // navigations, which breaks opening a file or app link from elsewhere.
        'SameSite=Lax',
        'Path=/api',
        `Max-Age=${60 * 60 * 24 * 30}`,
        ...(secure ? ['Secure'] : []),
      ].join('; '),
    )
    return { ok: true }
  })

  // ── Connection settings ────────────────────────────────────────────────────
  //
  // Reachable at any time, unlike the onboarding wizard, which skips its token
  // step once any token is stored — so an instance set up with a bad key had no
  // way back short of editing secrets.json on the host.

  // GET /connection — both providers, credentials redacted.
  //
  // They are independent, not a mode: with each configured the model picker
  // offers Claude and the gateway's catalogue together, and whichever model a
  // conversation is on decides where its turn is sent.
  app.get('/connection', { onRequest: [app.authenticate] }, async () => {
    const secrets = readSecrets()
    const baseUrl = (secrets.providerBaseUrl as string) || process.env.ANTHROPIC_BASE_URL || ''
    const oauth = (secrets.claudeOauthToken as string) || process.env.CLAUDE_CODE_OAUTH_TOKEN || ''
    const gatewayKey = (secrets.providerAuthToken as string) || process.env.ANTHROPIC_AUTH_TOKEN || ''
    // Enough to recognise which key is installed, not enough to use it.
    const hint = (v: string) => (v ? `${v.slice(0, 12)}…${v.slice(-4)}` : '')
    return {
      anthropic: {
        configured: !!oauth,
        credentialHint: hint(oauth),
        // The OAuth token is read from the environment first, so a value there
        // overrides whatever the UI saves.
        envManaged: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
        defaultModel: defaultModelFor('anthropic'),
      },
      gateway: {
        configured: !!(baseUrl && gatewayKey),
        baseUrl,
        credentialHint: hint(gatewayKey),
        // Gateway settings prefer the stored values, so the environment only
        // wins when nothing is stored.
        envManaged: !secrets.providerBaseUrl && !!process.env.ANTHROPIC_BASE_URL,
        defaultModel: defaultModelFor('gateway'),
      },
      // Which provider new conversations start on. Reported even with one
      // provider configured — it is then forced, and the UI says so rather
      // than offering a choice that isn't one.
      defaultProvider: defaultProvider(),
    }
  })

  // PUT /connection/defaults — which provider new conversations use, and the
  // model each one starts on.
  //
  // Separate from POST /connection because it changes no credential and needs
  // no verification round-trip: it is a preference, and saving it should not
  // depend on the provider being reachable at that moment.
  app.put('/connection/defaults', { onRequest: [app.authenticate] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      provider?: string
      anthropicModel?: string
      gatewayModel?: string
    }
    const secrets = readSecrets()

    if (body.provider !== undefined) {
      if (body.provider !== 'anthropic' && body.provider !== 'gateway') {
        return reply.code(400).send({ error: 'provider must be "anthropic" or "gateway"' })
      }
      secrets.defaultProvider = body.provider
    }

    // A namespaced id routes to the gateway and a bare one to Anthropic, so a
    // model saved under the wrong provider would send every new conversation
    // somewhere it cannot be served. Reject rather than silently re-route: the
    // picker should never offer such a pairing, and if it does we want to know.
    const check = (model: string, provider: Provider): string | null => {
      const namespaced = model.includes('/')
      if (provider === 'gateway' && !namespaced) {
        return 'A gateway default must be a namespaced model id (e.g. "google/gemini-3.8-flash")'
      }
      if (provider === 'anthropic' && namespaced) {
        return 'A Claude default must be a bare model id (e.g. "claude-opus-5")'
      }
      return null
    }

    if (body.anthropicModel !== undefined) {
      const model = body.anthropicModel.trim()
      if (model) {
        const err = check(model, 'anthropic')
        if (err) return reply.code(400).send({ error: err })
        secrets.defaultModelAnthropic = model
      } else {
        delete secrets.defaultModelAnthropic
      }
    }

    if (body.gatewayModel !== undefined) {
      const model = body.gatewayModel.trim()
      if (model) {
        const err = check(model, 'gateway')
        if (err) return reply.code(400).send({ error: err })
        secrets.defaultModelGateway = model
      } else {
        delete secrets.defaultModelGateway
      }
    }

    writeSecrets(secrets)
    return {
      ok: true,
      defaultProvider: defaultProvider(),
      anthropicModel: defaultModelFor('anthropic'),
      gatewayModel: defaultModelFor('gateway'),
    }
  })

  // DELETE /connection/:provider — forget one, keep the other.
  app.delete<{ Params: { provider: string } }>(
    '/connection/:provider',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const secrets = readSecrets()
      if (req.params.provider === 'anthropic') {
        delete secrets.claudeOauthToken
      } else if (req.params.provider === 'gateway') {
        delete secrets.providerBaseUrl
        delete secrets.providerAuthToken
      } else {
        return reply.code(400).send({ error: 'Unknown provider' })
      }
      writeSecrets(secrets)
      await recycleSessions()
      return { ok: true }
    },
  )

  // POST /connection — verify a credential, then persist it if it works.
  // Verification is not optional: accepting an unusable key silently is the
  // whole bug this endpoint exists to fix.
  app.post('/connection', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { mode, baseUrl, credential } = req.body as {
      mode?: 'anthropic' | 'gateway'
      baseUrl?: string
      credential?: string
    }

    if (mode !== 'anthropic' && mode !== 'gateway') {
      return reply.code(400).send({ error: 'mode must be "anthropic" or "gateway"' })
    }
    if (!credential || !credential.trim()) {
      return reply.code(400).send({ error: 'Credential is required' })
    }
    const cred = credential.trim()

    let url = ''
    if (mode === 'gateway') {
      url = (baseUrl || '').trim().replace(/\/+$/, '')
      if (!/^https?:\/\//.test(url)) {
        return reply.code(400).send({ error: 'Base URL must start with http:// or https://' })
      }
    }

    const check = await verifyConnection(
      mode === 'gateway'
        ? { baseUrl: url, authToken: cred }
        : { oauthToken: cred },
    )
    if (!check.ok) {
      return reply.code(400).send({
        error: check.error || 'Those credentials did not work.',
        verificationFailed: true,
      })
    }

    // Each provider is saved on its own. Setting one used to clear the other,
    // which made them mutually exclusive — the reason a single instance could
    // not offer Claude and a gateway's models side by side.
    const secrets = readSecrets()
    if (mode === 'gateway') {
      secrets.providerBaseUrl = url
      secrets.providerAuthToken = cred
    } else {
      secrets.claudeOauthToken = cred
    }
    writeSecrets(secrets)

    // Idle sessions are replaced so the next turn uses the new provider; a
    // conversation mid-turn finishes on the old one.
    const { busy } = await recycleSessions()
    return { ok: true, busy }
  })
}
