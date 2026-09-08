// Drives the demo instance in a headless browser and records the session.
//
// Not run directly — `bash demo/record/record.sh` runs this inside the pinned
// Playwright image and converts the result to a GIF. The browser has to run in
// a container: the headless Chromium needs GTK/ATK system libraries that
// `playwright install-deps` only knows how to install on Debian/Ubuntu.
//
// Reads demo/.env for the login, so it always follows whatever `demo.sh seed`
// generated.
//
// Output: demo/record/out/video/*.webm  (record.sh turns it into the GIF)
//
// Why a script rather than a screen capture: a take is reproducible. When the
// UI changes, re-run it and the recording is regenerated with identical pacing
// and framing instead of being re-performed by hand.
import { chromium } from 'playwright'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const OUT = join(HERE, 'out')
const VIDEO_DIR = join(OUT, 'video')

// Rendered at deviceScaleFactor 2 and downscaled by ffmpeg later — that
// downscale is what makes the text look sharp rather than sampled.
const VIEWPORT = { width: 1280, height: 800 }

// Inside the container the demo is reached over its own Compose network by
// service name, not through the host's published loopback port.
const FRONTEND = process.env.DEMO_URL ?? 'http://frontend:5173'

// ── The take ────────────────────────────────────────────────────────────────
// Each prompt is sent, awaited to completion, then held on screen for `hold`
// ms so a viewer can actually read the reply before the next one starts.
const SCRIPT = [
  { prompt: 'What can you do?', hold: 3500 },
  { prompt: 'Remind me every Friday at 6pm to write the weekly recap.', hold: 3500 },
]

function env(key) {
  const raw = readFileSync(join(REPO, 'demo', '.env'), 'utf8')
  const line = raw.split('\n').find((l) => l.startsWith(`${key}=`))
  if (!line) throw new Error(`${key} missing from demo/.env — run: bash demo/demo.sh seed`)
  return line.slice(key.length + 1)
}

// Types into the composer at a human cadence. Playwright's default fill() is
// instantaneous, which reads as a paste rather than someone typing.
async function type(page, selector, text) {
  await page.click(selector)
  await page.type(selector, text, { delay: 45 })
}

async function main() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(VIDEO_DIR, { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
    colorScheme: 'dark',
  })
  const page = await context.newPage()

  await page.goto(FRONTEND, { waitUntil: 'networkidle' })

  // ── Login ──
  await page.fill('input[type=email]', env('ADMIN_EMAIL'))
  await page.fill('input[type=password]', env('ADMIN_PASSWORD'))
  await page.click('button[type=submit]')

  // A freshly seeded instance lands on the onboarding flow instead of the
  // chat. Dismiss it — the take is about the chat — but conditionally: the
  // dismissal sticks, so every run after the first goes straight through.
  // ("Skip onboarding" is the button's title, not its text.)
  await page.waitForTimeout(2500)
  if (page.url().includes('/onboarding')) {
    await page.click('button[title="Skip onboarding"]')
  }

  // The home screen has no composer — it appears once a conversation is open.
  // Going through the sidebar's "New chat" rather than the home screen's "New
  // conversation" button keeps this working whichever screen we landed on, and
  // starts every take from an empty thread.
  await page.click('button:has-text("New chat")')

  const composer = 'textarea[placeholder="How can I help you today?"]'
  await page.waitForSelector(composer, { timeout: 30_000 })
  await page.waitForTimeout(1200)

  // ── Conversation ──
  for (const { prompt, hold } of SCRIPT) {
    await type(page, composer, prompt)
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')

    // The Stop button is mounted only while a turn is running, so its
    // appearance and disappearance bracket exactly one reply. Waiting on it
    // beats a fixed sleep: the take is never cut off mid-answer, and never
    // sits on a finished screen for longer than the hold below.
    const stop = 'button[title="Stop"]'
    await page.waitForSelector(stop, { timeout: 30_000 }).catch(() => {})
    await page.waitForSelector(stop, { state: 'detached', timeout: 300_000 })
    await page.waitForTimeout(hold)
  }

  await context.close() // flushes the video file
  await browser.close()
  console.log('take recorded')
}

main().catch((e) => { console.error(e); process.exit(1) })
