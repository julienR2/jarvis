import { test, expect, signIn } from '../helpers'

/**
 * The home page: a composer, then what Jarvis did without you today.
 * Fixtures: today's brief done, the hook done 3 h ago, the yearly cron's run
 * failed 45 min ago with nothing succeeding since, one enabled cron (yearly).
 */
test.describe('today', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('the composer comes first, and the header says which day it is', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
    const composer = page.getByPlaceholder('How can I help you today?')
    await expect(composer).toBeVisible()
    // Composer above the first section, whatever the day holds.
    const section = page.getByTestId('today-needs')
    const [c, s] = await Promise.all([composer.boundingBox(), section.boundingBox()])
    expect(c && s && c.y < s.y).toBeTruthy()
  })

  test('needs you: the failure nothing has fixed yet, with its error and a retry', async ({ page }) => {
    const needs = page.getByTestId('today-needs')
    await expect(needs.getByRole('heading', { name: /Needs you · 1/ })).toBeVisible()
    const row = needs.getByTestId('today-row')
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-status', 'error')
    await expect(row.getByText('new-year-wish')).toBeVisible()
    await expect(row.getByText(/greetings API answered 503/)).toBeVisible()
    await expect(row.getByRole('button', { name: /Retry/ })).toBeVisible()
    // Yesterday's failed brief is not here: this morning's brief succeeded.
    await expect(needs.getByText('morning-brief')).toBeHidden()
  })

  test('done today lists the runs that finished, and opens their chat', async ({ page }) => {
    // The seeded "done" runs are 62 and 180 minutes old; right after local
    // midnight they belong to yesterday and the section is rightly absent.
    test.skip(new Date().getHours() < 4, 'fixture runs fall on yesterday this close to midnight')
    const done = page.getByTestId('today-done')
    await expect(done.getByRole('heading', { name: 'Done today' })).toBeVisible()
    await expect(done.getByText('morning-brief')).toBeVisible()
    await expect(done.getByText('fixture-hook')).toBeVisible()
    await expect(done.getByText(/done · \d+ min/).first()).toBeVisible()
    await done.getByTestId('today-row').filter({ hasText: 'fixture-hook' }).getByRole('button', { name: 'Open' }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000002$/)
  })

  test('a row whose chat carries an app says so', async ({ page }) => {
    const row = page.getByTestId('today-needs').getByTestId('today-row')
    await row.getByRole('button', { name: 'Open app' }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000004$/)
  })

  test('coming up: only enabled crons, soonest first, gear opens the definition', async ({ page }) => {
    const up = page.getByTestId('today-upcoming')
    await expect(up.getByRole('heading', { name: 'Coming up' })).toBeVisible()
    const rows = up.getByTestId('today-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first().getByText('new-year-wish')).toBeVisible()
    await expect(rows.first().getByText(/1 Jan|Jan 1/)).toBeVisible()
    await expect(up.getByText('morning-brief')).toBeHidden()
    await rows.first().getByTitle("Open this cron's settings").click()
    await expect(page).toHaveURL(/\/activity\?/)
    await expect(page.getByRole('heading', { name: 'Edit cron' })).toBeVisible()
    await expect(page.getByPlaceholder(/Name/)).toHaveValue('new-year-wish')
  })

  test('nothing is running, so no "happening now" and no running pill', async ({ page }) => {
    await expect(page.getByTestId('today-needs')).toBeVisible()
    await expect(page.getByTestId('today-now')).toBeHidden()
    await expect(page.getByTestId('today-running')).toBeHidden()
  })

  test('on a phone the actions sit under the row, full width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const row = page.getByTestId('today-needs').getByTestId('today-row')
    const open = row.getByRole('button', { name: 'Open app' })
    const retry = row.getByRole('button', { name: /Retry/ })
    await expect(open).toBeVisible()
    await expect(retry).toBeVisible()
    const [name, o, r] = await Promise.all([row.getByText('new-year-wish').boundingBox(), open.boundingBox(), retry.boundingBox()])
    // Same line as each other, below the text.
    expect(o && r && Math.abs(o.y - r.y) < 2).toBeTruthy()
    expect(name && o && o.y > name.y + name.height).toBeTruthy()
    expect(o && o.width > 120).toBeTruthy()
  })
})
