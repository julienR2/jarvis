import { test, expect, signIn } from '../helpers'

/**
 * Routines run in threads. Fixtures: surf-watch reports into "🏄 Surf" — three
 * runs with nothing to say, then one with news; price-watch stands alone and
 * had news (listed in Threads); backup-check stands alone and only ever said
 * nothing (listed nowhere).
 */
const SURF = '00000000-0000-4000-8000-00000000000f'
const SURF_THREAD = '00000000-0000-4000-8000-000000000010'
const PRICE_THREAD = '00000000-0000-4000-8000-000000000011'

test.describe('threads', () => {
  // In order: the first reads the Surf chat's badge before anything opens it.
  test.describe.configure({ mode: 'serial' })
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('a chat shows its routine’s silent runs as one line and its news as a report', async ({ page }) => {
    // Silent runs count as nothing: the one unread is the report. (Read
    // before the chat is opened — opening it marks it read.)
    await page.goto('')
    const row = page.locator('aside').getByText('🏄 Surf', { exact: true }).locator('..')
    await expect(row.getByText('1', { exact: true })).toBeVisible()
    await page.goto(`c/${SURF}`)
    await expect(page.getByTestId('run-report-stack')).toHaveCount(1)
    await expect(page.getByTestId('run-report-stack')).toContainText('surf-watch ran 3× · nothing to report')
    const report = page.getByTestId('run-report')
    await expect(report).toHaveCount(1)
    await expect(report).toContainText('Go now.')
  })

  test('the Threads group lists the standalone thread with news — and only that', async ({ page }) => {
    await page.goto('')
    const threads = page.getByTestId('threads-group')
    await expect(threads.getByText('price-watch', { exact: true })).toBeVisible()
    await expect(threads.getByText('backup-check', { exact: true })).toHaveCount(0)
    // A routine's thread is never filed with the chats.
    const sidebar = page.locator('aside')
    await expect(sidebar.getByText('surf-watch', { exact: true })).toHaveCount(0)
    await expect(sidebar.getByText('backup-check', { exact: true })).toHaveCount(0)
  })

  test('a report opens its thread at that run, and the thread joins the Threads group', async ({ page }) => {
    await page.goto(`c/${SURF}`)
    await page.getByTestId('run-report').getByTitle('Open the thread at this run').click()
    await expect(page).toHaveURL(new RegExp(`/c/${SURF_THREAD}\\?run=`))
    const runId = new URL(page.url()).searchParams.get('run')!
    await expect(page.locator(`[data-run-id="${runId}"]`)).toBeInViewport()
    await expect(page.getByTestId('threads-group').getByText('surf-watch', { exact: true })).toBeVisible()
    // Navigating away does not put it back.
    await page.goto('')
    await expect(page.getByTestId('threads-group').getByText('surf-watch', { exact: true })).toBeVisible()
    // Put away — not deleted: the chat's report still leads there.
    await page.getByTestId('threads-group').getByText('surf-watch', { exact: true }).hover()
    await page.getByRole('button', { name: 'Put away surf-watch' }).click()
    await expect(page.getByTestId('threads-group').getByText('surf-watch', { exact: true })).toHaveCount(0)
    await page.goto(`c/${SURF_THREAD}`)
    await expect(page.getByTestId('run-card').first()).toBeVisible()
    // Put away from where it is open: it goes, and stays gone.
    await page.getByTestId('threads-group').getByText('surf-watch', { exact: true }).hover()
    await page.getByRole('button', { name: 'Put away surf-watch' }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.waitForTimeout(800)
    await expect(page.getByTestId('threads-group').getByText('surf-watch', { exact: true })).toHaveCount(0)
    await page.goto(`c/${SURF_THREAD}`)
    await expect(page.getByTestId('run-card').first()).toBeVisible()
    // Leave it as found.
    await page.goto('')
    await page.getByTestId('threads-group').getByText('surf-watch', { exact: true }).hover()
    await page.getByRole('button', { name: 'Put away surf-watch' }).click()
  })

  test('a routine’s runs open under it on the Routines page, each into its thread', async ({ page }) => {
    await page.goto('routines')
    const row = page.getByTestId('routine-row').filter({ hasText: 'price-watch' })
    await expect(row.getByText('its own thread')).toBeVisible()
    await row.getByRole('button', { name: /last ran/ }).click()
    const runs = row.getByTestId('routine-runs').getByRole('button')
    await expect(runs).toHaveCount(2)
    await runs.first().click()
    await expect(page).toHaveURL(new RegExp(`/c/${PRICE_THREAD}\\?run=`))
    await expect(page.getByText('Dropped to')).toBeVisible()
  })
})
