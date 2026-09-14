import { test as base, expect, type Page } from '@playwright/test'
import { appendFileSync } from 'fs'

/**
 * Two things every spec gets for free:
 *
 * - a console guard: an uncaught exception or a console.error during the test
 *   fails it, whatever it was asserting. The cheapest regression net there is,
 *   and the one most likely to catch a renderer blowing up on fixture data.
 * - `signIn(page)`: the e2e session, planted before the first script runs.
 */
// Chrome's own "Failed to load resource" lines are judged through the response
// tracker below instead, where the URL and status are known.
const IGNORE_CONSOLE = [
  /favicon/i,
  /React DevTools/i,
  /\[vite\]/,
  /Failed to load resource/,
  // The backend sets COOP; over plain http between containers Chrome discards
  // it and says so. Behind https it is honoured silently.
  /Cross-Origin-Opener-Policy/,
]

// Responses that are part of a test's own script rather than a defect.
const EXPECTED_RESPONSES: Array<{ status: number; path: RegExp }> = [
  { status: 401, path: /\/api\/auth\/login$/ }, // the wrong-password test
]

export const test = base.extend<{ consoleGuard: void }>({
  consoleGuard: [
    async ({ page }, use, testInfo) => {
      const problems: string[] = []
      page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`))
      page.on('console', (m) => {
        if (m.type() !== 'error') return
        const text = m.text()
        if (IGNORE_CONSOLE.some((re) => re.test(text))) return
        problems.push(`console.error: ${text}`)
      })
      // Any 4xx/5xx the page provoked is a wrong path, a missing asset or a
      // broken call — under a mount prefix, exactly the class of bug to catch.
      page.on('response', (res) => {
        const status = res.status()
        if (status < 400) return
        const path = new URL(res.url()).pathname
        if (EXPECTED_RESPONSES.some((e) => e.status === status && e.path.test(path))) return
        problems.push(`${status} ${res.request().method()} ${path}`)
      })
      // E2E_COUNT=1 writes every API call each test made to results/requests.log.
      // The backend allows 300 requests a minute per client and the whole suite
      // is one client, so when 429s appear this is how to see what to trim.
      const apiCalls: string[] = []
      page.on('request', (r) => { if (/\/api\//.test(r.url())) apiCalls.push(`${r.method()} ${new URL(r.url()).pathname}`) })
      await use()
      if (process.env.E2E_COUNT) appendFileSync('results/requests.log', `${testInfo.title}\n  ${apiCalls.join('\n  ')}\n`)
      expect(problems, 'no console errors or failed requests during the test').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

/** Plant the e2e session and open the app. */
export async function signIn(page: Page): Promise<void> {
  const token = process.env.E2E_TOKEN
  if (!token) throw new Error('E2E_TOKEN missing — did globalSetup run?')
  await page.context().addInitScript((t) => {
    if (!localStorage.getItem('token')) localStorage.setItem('token', t)
  }, token)
  await page.goto('./')
  await expect(page.getByText('New chat')).toBeVisible()
}

/**
 * Open a seeded conversation from the sidebar. Substring match on purpose:
 * titles carry an emoji prefix ("🗞️ Morning brief"), like real ones do.
 */
export async function openConversation(page: Page, title: string): Promise<void> {
  await page.getByText(title).first().click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
}
