import { readFileSync } from 'fs'

/**
 * Log in as the e2e account and hand the token to the specs through the
 * environment (Playwright forwards process.env from here to the workers).
 *
 * There is nothing to clean up first: `run.sh` starts a backend on a database
 * created moments ago, so the fixtures seeded at its boot are the whole of it.
 * The e2e account's password is random per seed and lands in a file next to
 * that database — which is why it is read here and not baked into a spec.
 */
const API = process.env.E2E_API || 'http://127.0.0.1:3105'
const CREDS = process.env.E2E_CREDENTIALS

export default async function globalSetup() {
  if (!CREDS) throw new Error('E2E_CREDENTIALS is not set — start the suite through run.sh')

  const creds = JSON.parse(readFileSync(CREDS, 'utf8')) as { email: string; password: string }
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds),
  })
  if (!r.ok) throw new Error(`login as ${creds.email} failed: ${r.status}`)
  const { token } = (await r.json()) as { token: string }
  process.env.E2E_TOKEN = token
  process.env.E2E_EMAIL = creds.email
  process.env.E2E_PASSWORD = creds.password
}
