import { readFileSync } from 'fs'

/**
 * Before the run: put the fixtures back in place, then log in as the e2e
 * account and hand the token to the specs through the environment (Playwright
 * forwards process.env from here to the workers).
 *
 * Re-arming (POST /internal/fixtures) replaces only the fixture-owned rows and
 * leaves everything else on the instance alone — next is also where a person
 * tries things live, and a run of this suite must not take their data with it.
 * The full wipe (POST /internal/reset) is opt-in: E2E_RESET=1. Specs assert on
 * the fixtures by name for the same reason; they never count the whole table.
 *
 * The e2e account's password lives in a file only the containers can read and
 * changes when the database is wiped — read it AFTER, not before.
 */
const API = process.env.E2E_API || 'http://next-backend:3005'
const CREDS = process.env.E2E_CREDENTIALS || '/jarvis/agent/next/data/e2e-credentials.json'

async function health(): Promise<number | null> {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return null
    return (await r.json()).uptime ?? 0
  } catch {
    return null
  }
}

export default async function globalSetup() {
  const secret = process.env.INTERNAL_SECRET
  if (!secret) throw new Error('INTERNAL_SECRET is needed to re-arm the fixtures on next')
  if (process.env.E2E_RESET === '1') {
    const r = await fetch(`${API}/internal/reset`, { method: 'POST', headers: { 'X-Internal-Secret': secret } })
    if (!r.ok) throw new Error(`reset refused: ${r.status} ${await r.text()}`)
    // The old process answers for a moment more; wait for one that is younger
    // than the request.
    const deadline = Date.now() + 30_000
    for (;;) {
      await new Promise((res) => setTimeout(res, 500))
      const up = await health()
      if (up !== null && up < 10) break
      if (Date.now() > deadline) throw new Error('next did not come back within 30s after reset')
    }
  } else {
    if ((await health()) === null) throw new Error(`next is not reachable at ${API}`)
    const r = await fetch(`${API}/internal/fixtures`, { method: 'POST', headers: { 'X-Internal-Secret': secret } })
    if (!r.ok) throw new Error(`could not re-arm the fixtures: ${r.status} ${await r.text()}`)
  }

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
