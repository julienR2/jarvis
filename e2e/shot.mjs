/**
 * Screenshot routes of the throwaway stack. Started by shot.sh, which has the
 * stack up and the environment set (E2E_BASE_URL, E2E_API, E2E_CREDENTIALS).
 *
 *   node shot.mjs <out-dir> [--phone] <route> [route...]
 *
 * A route is what goes after the origin: '' for Today, 'routines', 'settings',
 * 'c/00000000-0000-4000-8000-000000000001' for a fixture chat. Each one lands
 * as one full-page PNG, and the paths are printed for the caller to link.
 */
import { readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const outDir = args.shift()
const phone = args.includes('--phone')
const routes = args.filter((a) => a !== '--phone')
if (!outDir || routes.length === 0) {
  console.error('usage: node shot.mjs <out-dir> [--phone] <route> [route...]')
  process.exit(2)
}

const base = process.env.E2E_BASE_URL.replace(/\/?$/, '/')
const creds = JSON.parse(readFileSync(process.env.E2E_CREDENTIALS, 'utf8'))
const res = await fetch(`${process.env.E2E_API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(creds),
})
if (!res.ok) throw new Error(`login as ${creds.email} failed: ${res.status}`)
const { token } = await res.json()

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({
  viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  deviceScaleFactor: 2,
})
// Planted before the first script runs, so the app is never briefly logged out.
await context.addInitScript((t) => localStorage.setItem('token', t), token)

for (const route of routes) {
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`) })

  await page.goto(base + route.replace(/^\//, ''), { waitUntil: 'networkidle' })
  const name = (route.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'today') + (phone ? '-phone' : '')
  const file = join(outDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log(file + (problems.length ? `  ⚠ ${problems.join(' | ')}` : ''))
  await page.close()
}

await browser.close()
