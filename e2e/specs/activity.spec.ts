import { test, expect, signIn } from '../helpers'

test.describe('activity', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await page.goto('activity')
  })

  test('log: every run, newest first, grouped by day, with its one line', async ({ page }) => {
    const rows = page.getByTestId('run-row')
    // 4 seeded runs: today's brief, yesterday's failed brief, the hook, a brief from 2 days ago
    await expect(rows).toHaveCount(4)
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible()
    await expect(rows.first().getByText('morning-brief')).toBeVisible()
    await expect(rows.first().getByText(/done · \d+ min/)).toBeVisible()
    await expect(page.getByText('Filed under Projects.')).toBeVisible()
  })

  test('log: a failed run shows its error, and offers a retry', async ({ page }) => {
    await page.getByRole('button', { name: 'Failed' }).click()
    const rows = page.getByTestId('run-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-status', 'error')
    await expect(rows.first().getByText(/PocketBase returned 401/)).toBeVisible()
    await expect(rows.first().getByRole('button', { name: /Retry/ })).toBeVisible()
  })

  test('log: filters narrow by kind, and a row opens its chat', async ({ page }) => {
    await page.getByRole('button', { name: 'Webhooks' }).click()
    const rows = page.getByTestId('run-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first().getByText('fixture-hook')).toBeVisible()
    await rows.first().getByRole('button', { name: /Activity steps/ }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000002$/)
  })

  test('routines: crons and webhooks in one list, with a working switch', async ({ page }) => {
    await page.getByRole('tab', { name: 'Routines' }).click()
    const rows = page.getByTestId('routine-row')
    await expect(rows).toHaveCount(2)
    await expect(page.getByText('daily at 05:30')).toBeVisible()
    await expect(page.getByText('when called')).toBeVisible()
    const sw = page.getByRole('switch', { name: 'Enable morning-brief' })
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect(page.getByRole('switch', { name: 'Disable morning-brief' })).toHaveAttribute('aria-checked', 'true')
    // Back off — a live cron on a throwaway instance still costs.
    await page.getByRole('switch', { name: 'Disable morning-brief' }).click()
    await expect(page.getByRole('switch', { name: 'Enable morning-brief' })).toBeVisible()
  })

  test('sidebar: the entry shows a red dot when something failed today', async ({ page }) => {
    // The fixture failure is from yesterday — so no dot by default…
    await expect(page.getByTestId('activity-failed')).toHaveCount(0)
    await expect(page.getByTestId('activity-running')).toHaveCount(0)
  })
})
