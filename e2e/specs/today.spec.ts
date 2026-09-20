import { test, expect, signIn } from '../helpers'

/**
 * The home page: a greeting and the composer, then the day's inbox.
 * Fixtures: today's brief done, the hook done 3 h ago (plus three quiet fires),
 * the yearly cron's run failed 45 min ago with nothing succeeding since, two
 * runs and one chat waiting on the person, one enabled cron (yearly).
 */
test.describe('today', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('the greeting and the composer come first, and the header says which day it is', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
    await expect(page.getByText('How can I help you today?').first()).toBeVisible()
    const composer = page.getByPlaceholder('How can I help you today?')
    await expect(composer).toBeVisible()
    // Composer above the first section, whatever the day holds.
    const section = page.getByTestId('today-needs')
    const [c, s] = await Promise.all([composer.boundingBox(), section.boundingBox()])
    expect(c && s && c.y < s.y).toBeTruthy()
    // No setup-wizard link cluttering home: it lives in Settings now.
    await expect(page.getByText('Setup wizard')).toBeHidden()
  })

  test('needs you: the failure nothing has fixed yet, its error leading, with a retry', async ({ page }) => {
    const needs = page.getByTestId('today-needs')
    await expect(needs.getByRole('heading', { name: /Needs you · \d/ })).toBeVisible()
    // The questions waiting for an answer are needs-you.spec's; here, the failure.
    const row = needs.locator('[data-testid="today-row"][data-status="error"]').filter({ hasText: 'new-year-wish' })
    await expect(row).toHaveCount(1)
    await expect(row.getByText(/greetings API answered 503/)).toBeVisible()
    await expect(row.getByRole('button', { name: /Retry/ })).toBeVisible()
    // Yesterday's failed brief is not here: this morning's brief succeeded.
    await expect(needs.getByText('morning-brief')).toBeHidden()
  })

  test('worth telling you: the result leads, the routine is the small print, and Open goes to its chat', async ({ page }) => {
    // The seeded "done" runs are 62 and 180 minutes old; right after local
    // midnight they belong to yesterday and the section is rightly absent.
    test.skip(new Date().getHours() < 4, 'fixture runs fall on yesterday this close to midnight')
    const done = page.getByTestId('today-done')
    await expect(done.getByRole('heading', { name: 'Worth telling you' })).toBeVisible()
    // The three skipped triages are counted on one line, not listed.
    await expect(page.getByTestId('today-quiet')).toContainText('3 runs had nothing to report')
    const brief = done.getByTestId('today-row').filter({ hasText: 'morning-brief' })
    await expect(brief.getByText('Brief posted')).toBeVisible()
    // No status pill: being in this section is the status.
    await expect(brief.getByText(/done ·/)).toHaveCount(0)
    await brief.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000003$/)
  })

  test('a result is put away with one click and stays away', async ({ page }) => {
    test.skip(new Date().getHours() < 4, 'fixture runs fall on yesterday this close to midnight')
    const done = page.getByTestId('today-done')
    const hook = done.getByTestId('today-row').filter({ hasText: 'fixture-hook' })
    await expect(hook).toHaveCount(1)
    await hook.getByRole('button', { name: 'Put away fixture-hook' }).click()
    await expect(hook).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('today-needs')).toBeVisible()
    await expect(page.getByTestId('today-done').getByTestId('today-row').filter({ hasText: 'fixture-hook' })).toHaveCount(0)
    // The chat keeps what it wrote.
    await page.goto('c/00000000-0000-4000-8000-000000000002')
    await expect(page.getByText('Filed under Projects.')).toBeVisible()
  })

  test('a row whose chat carries an app says so', async ({ page }) => {
    const row = page.getByTestId('today-needs').getByTestId('today-row').filter({ hasText: 'new-year-wish' })
    await row.getByRole('button', { name: 'Open app' }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000004$/)
  })

  test('coming up: only enabled crons, soonest first, the gear opens the routine', async ({ page }) => {
    const up = page.getByTestId('today-upcoming')
    await expect(up.getByRole('heading', { name: 'Coming up' })).toBeVisible()
    // The yearly fixture cron is here, the paused daily one is not; a person's
    // own enabled crons may sit alongside.
    const rows = up.getByTestId('today-row').filter({ hasText: 'new-year-wish' })
    await expect(rows).toHaveCount(1)
    await expect(rows.first().getByText(/1 Jan|Jan 1/)).toBeVisible()
    await expect(up.getByText('morning-brief')).toBeHidden()
    await rows.first().getByTitle('Open this routine').click()
    await expect(page).toHaveURL(/\/routines/)
    await expect(page.getByRole('heading', { name: 'Edit routine' })).toBeVisible()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('new-year-wish')
  })

  test('nothing is running, so no "running" section', async ({ page }) => {
    await expect(page.getByTestId('today-needs')).toBeVisible()
    await expect(page.getByTestId('today-now')).toBeHidden()
  })

  test('the sidebar entry shows one dot, the most urgent — amber while something waits on you', async ({ page }) => {
    // Two runs wait for an answer, the yearly cron's run failed this morning,
    // nothing is running: amber wins over red, and there is never more than one.
    await expect(page.getByTestId('activity-waiting')).toHaveCount(1)
    await expect(page.getByTestId('activity-failed')).toHaveCount(0)
    await expect(page.getByTestId('activity-running')).toHaveCount(0)
  })

  test('on a phone the rows keep their actions and nothing overflows', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const row = page.getByTestId('today-needs').getByTestId('today-row').filter({ hasText: 'new-year-wish' })
    await expect(row.getByRole('button', { name: 'Open app' })).toBeVisible()
    await expect(row.getByRole('button', { name: /Retry/ })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(overflow).toBeFalsy()
  })
})
