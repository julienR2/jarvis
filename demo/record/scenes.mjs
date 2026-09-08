// Screenshots every page of the demo instance, for the README and the landing
// page, and as the frames the tour GIF is built from.
//
// Not run directly — `bash demo/record/shots.sh` runs this inside the pinned
// Playwright image (see record.sh for why the browser has to be containerised).
//
// Output: demo/record/out/shots/<theme>/<name>.png at 2560x1600 — a 1280x800
// viewport rendered at deviceScaleFactor 2, i.e. retina. They are published at
// that size and displayed at 1280 CSS px, so the extra pixels land on high-DPI
// screens instead of being thrown away.
//
// Both themes are captured in one pass. The site swaps its <img> on the theme
// the visitor is using, and a dark screenshot on a light page (or the reverse)
// is the thing that always looks broken.
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SHOTS = join(HERE, 'out', 'shots')

// Jarvis reads its theme from localStorage; there is no URL switch. Seeding the
// key before the app's first paint is what avoids capturing a flash of the
// wrong theme, so it goes in as an init script rather than a click afterwards.
const THEMES = (process.env.DEMO_THEMES ?? 'dark,light').split(',').filter(Boolean)

const VIEWPORT = { width: 1280, height: 800 }
// Reached on localhost, not over the Compose network — see shots.sh for why
// (the Browser page needs a secure context, and localhost counts as one).
const FRONTEND = process.env.DEMO_URL ?? 'http://localhost:5273'

// Each page, and how long to let it settle. `wait` covers the pages that fetch
// before they have anything to draw — a screenshot taken at load is a spinner.
const PAGES = [
  { name: 'home',       path: '/',            wait: 1500 },
  { name: 'crons',      path: '/crons',       wait: 1200 },
  { name: 'webhooks',   path: '/webhooks',    wait: 1200 },
  // The page now leads with the model provider; the services grid is what the
  // connectors shot has always been about, so scroll it into frame.
  { name: 'connectors', path: '/connectors',  wait: 1500, scrollTo: 'SERVICES' },
  { name: 'connection', path: '/connection',  wait: 2500 },  // fetches the model catalogue
  { name: 'plugins',    path: '/plugins',     wait: 2500 },  // fetches the marketplace
  // No `browser` entry. That page embeds the Chromium container's own client,
  // which streams the screen over WebRTC, and the stream never negotiates
  // inside the capture browser — the shot is a "Waiting for stream…"
  // placeholder however long you wait for it. (Not a codec gap: this Chromium
  // reports H.264 for both <video> and WebRTC.) The page is fine in a real
  // browser on localhost or behind HTTPS, so shoot that one by hand.
  // ?tab=changed rather than the default Config listing: the diff view is the
  // point of this shot, and CodeBrowser reads its tab straight from the URL.
  { name: 'code',       path: '/code?tab=changed', wait: 2500 },
]

// The demo borrows your real CLAUDE_CODE_OAUTH_TOKEN so it boots into a
// working chat (see demo.sh seed), and the Connection page prints a masked
// form of whatever token is configured — real suffix included. These images
// are meant to be published, so the masked text is rewritten to an obvious
// placeholder before the shutter, in the page only: nothing stored changes,
// and the shot stays reproducible.
async function redactSecrets(page) {
  await page.evaluate(() => {
    const FAKE = { 'sk-ant-oat01': 'sk-ant-oat01…demo', 'sk-or-': 'sk-or-…demo' }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim()
      for (const [prefix, replacement] of Object.entries(FAKE)) {
        // Only the masked display form (prefix + ellipsis), never a field the
        // user is meant to type into — those are empty in the demo anyway.
        if (t.startsWith(prefix) && t.includes('…')) n.textContent = replacement
      }
    }
  })
}

const env = (k) => {
  const line = readFileSync(join(REPO, 'demo', '.env'), 'utf8')
    .split('\n').find((l) => l.startsWith(`${k}=`))
  if (!line) throw new Error(`${k} missing from demo/.env`)
  return line.slice(k.length + 1)
}

// Conversations are looked up by the title content.mjs gave them, so the chat
// and app shots follow the seed rather than hardcoded ids.
const API = process.env.DEMO_API ?? 'http://localhost:3105'
const auth = await (await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env('ADMIN_EMAIL'), password: env('ADMIN_PASSWORD') }),
})).json()
const convs = await (await fetch(`${API}/api/conversations`, {
  headers: { Authorization: `Bearer ${auth.token}` },
})).json()

const CHATS = [
  // The split view — chat on the left, the app the agent built on the right.
  { name: 'app', title: 'Weather for the week' },
  // The other app, kept because it shows a very different kind of thing built.
  { name: 'app-network', title: 'Neural networks, explained' },
  // A generated image sitting in the transcript.
  { name: 'image', title: 'Pixel art desert island' },
  // A plain answer with visible tool steps, in a conversation with no app.
  { name: 'chat', title: 'Server health check' },
]

async function capture(theme) {
  const dir = join(SHOTS, theme)
  mkdirSync(dir, { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: theme,
  })
  // Jarvis stores the preference itself, and reads it on first paint. Seeding
  // it before any script runs is what keeps a flash of the other theme out of
  // the shot; colorScheme above only covers what `system` would resolve to.
  await context.addInitScript((t) => {
    try { localStorage.setItem('jarvis-theme', t) } catch { /* private mode */ }
  }, theme)

  const page = await context.newPage()

  await page.goto(FRONTEND, { waitUntil: 'networkidle' })
  await page.fill('input[type=email]', env('ADMIN_EMAIL'))
  await page.fill('input[type=password]', env('ADMIN_PASSWORD'))
  await page.click('button[type=submit]')
  await page.waitForTimeout(2500)
  if (page.url().includes('/onboarding')) {
    await page.click('button[title="Skip onboarding"]')
    await page.waitForTimeout(2000)
  }

  for (const { name, path, wait, scrollTo, play } of PAGES) {
    await page.goto(`${FRONTEND}${path}`, { waitUntil: 'networkidle' }).catch(() => {})
    await page.waitForTimeout(wait)
    if (play) {
      // The client lives in an iframe, so the button is in a child frame.
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue
        const btn = await frame.$('text=Play Stream').catch(() => null)
        if (btn) { await btn.click().catch(() => {}); break }
      }
      await page.waitForTimeout(6000)   // let the first frames arrive
    }
    if (scrollTo) {
      await page.evaluate((needle) => {
        const el = [...document.querySelectorAll('*')]
          .find((n) => n.children.length === 0 && n.textContent.trim() === needle)
        el?.scrollIntoView({ block: 'start' })
      }, scrollTo)
      await page.waitForTimeout(600)
    }
    await redactSecrets(page)
    await page.screenshot({ path: join(dir, `${name}.png`) })
    console.log(`  ${theme}/${name}`)
  }

  for (const { name, title } of CHATS) {
    const conv = convs.find?.((c) => c.title === title)
    if (!conv) { console.log(`  (skipping ${name} — no conversation "${title}")`); continue }
    await page.goto(`${FRONTEND}/c/${conv.id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(3500)   // the app iframe renders after the messages
    // Land on the end of the answer rather than the top of a long transcript.
    await page.evaluate(() => {
      const el = document.querySelector('[class*="overflow-y-auto"]')
      if (el) el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(800)
    await redactSecrets(page)
    await page.screenshot({ path: join(dir, `${name}.png`) })
    console.log(`  ${theme}/${name}`)
  }

  await browser.close()
}

for (const theme of THEMES) await capture(theme)
