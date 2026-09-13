import { defineConfig } from '@playwright/test'

/**
 * UI-only checks against the `next` stack.
 *
 * Nothing here talks to the engine: the fixtures seeded into next's database
 * are what the tests look at, and the only writes are rows the UI itself
 * creates (a chat, an API key). `setup.ts` wipes and reseeds next before a run,
 * so every run starts from the same picture.
 *
 * Runs from the engine container — the only place both the repo and a Chromium
 * exist — against next by service name. `baseURL` carries the /next/ mount, so
 * specs navigate with RELATIVE paths (`page.goto('crons')`, never '/crons').
 */
const baseURL = (process.env.E2E_BASE_URL || 'http://next-frontend:5173/next').replace(/\/?$/, '/')

export default defineConfig({
  testDir: './specs',
  outputDir: './results',
  globalSetup: './setup.ts',
  // One throwaway database; the rows tests create (a chat, a key, a toggle)
  // don't collide, so two workers are safe and halve the run.
  workers: 2,
  fullyParallel: true,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['line']],
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      // The engine image ships Debian's Chromium (for puppeteer skills); the
      // runner's own download is not on disk and would not fit an arm64 host.
      executablePath: process.env.E2E_CHROMIUM || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
