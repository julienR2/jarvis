import { test, expect, signIn } from '../helpers'

test.describe('activity', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await page.goto('activity')
  })

  test('log: every run, newest first, grouped by day, with its one line', async ({ page }) => {
    const rows = page.getByTestId('run-row')
    // 5 seeded runs: today's brief and the yearly cron's failure, the hook, yesterday's failed brief, a brief from 2 days ago
    await expect(rows).toHaveCount(5)
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible()
    // Newest first: the yearly cron's failure (45 min ago) sits above this morning's brief.
    await expect(rows.first().getByText('new-year-wish')).toBeVisible()
    await expect(rows.filter({ hasText: 'morning-brief' }).first().getByText(/done · \d+ min/)).toBeVisible()
    await expect(page.getByText('Filed under Projects.')).toBeVisible()
  })

  test('log: a failed run shows its error, and offers a retry', async ({ page }) => {
    await page.getByRole('button', { name: 'Failed', exact: true }).click()
    const rows = page.getByTestId('run-row')
    await expect(rows).toHaveCount(2)
    const brief = rows.filter({ hasText: 'morning-brief' })
    await expect(brief).toHaveAttribute('data-status', 'error')
    await expect(brief.getByText(/PocketBase returned 401/)).toBeVisible()
    await expect(brief.getByRole('button', { name: /Retry/ })).toBeVisible()
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
    await expect(rows).toHaveCount(3)
    await expect(page.getByText('daily at 05:30')).toBeVisible()
    await expect(page.getByText('when called')).toBeVisible()
    await expect(page.getByTitle('Copy trigger URL')).toBeVisible()
    const sw = page.getByRole('switch', { name: 'Enable morning-brief' })
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect(page.getByRole('switch', { name: 'Disable morning-brief' })).toHaveAttribute('aria-checked', 'true')
    // Back off — a live cron on a throwaway instance still costs.
    await page.getByRole('switch', { name: 'Disable morning-brief' }).click()
    await expect(page.getByRole('switch', { name: 'Enable morning-brief' })).toBeVisible()
  })

  test('routines: a cron is created from the drawer and edited from its gear', async ({ page }) => {
    await page.getByRole('tab', { name: 'Routines' }).click()
    await page.getByRole('button', { name: 'New cron' }).click()
    const form = page.getByTestId('cron-form')
    await expect(form.getByRole('heading', { name: 'New cron' })).toBeVisible()
    await form.getByPlaceholder(/Name/).fill('e2e-nightly')
    await form.getByPlaceholder(/Schedule/).fill('0 3 * * *')
    await form.getByPlaceholder(/Prompt/).fill('Tidy up.')
    await form.getByLabel('Enabled').uncheck()
    await form.getByRole('button', { name: 'Create' }).click()
    await expect(form).toBeHidden()
    const row = page.getByTestId('routine-row').filter({ hasText: 'e2e-nightly' })
    await expect(row).toBeVisible()
    await expect(row.getByText('daily at 03:00')).toBeVisible()

    await row.getByTitle('Edit this cron').click()
    await expect(page.getByRole('heading', { name: 'Edit cron' })).toBeVisible()
    await expect(page.getByPlaceholder(/Name/)).toHaveValue('e2e-nightly')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('cron-form')).toBeHidden()
  })

  test('the old /crons address still lands, form open', async ({ page }) => {
    await page.goto('crons?edit=00000000-0000-4000-8000-0000000000c1')
    await expect(page).toHaveURL(/\/activity\?/)
    await expect(page.getByRole('heading', { name: 'Edit cron' })).toBeVisible()
    await expect(page.getByPlaceholder(/Name/)).toHaveValue('morning-brief')
  })

  test('sidebar: the entry shows a red dot when something failed today', async ({ page }) => {
    // The yearly cron's run failed this morning and nothing is running: red dot, no accent dot.
    await expect(page.getByTestId('activity-failed')).toHaveCount(1)
    await expect(page.getByTestId('activity-running')).toHaveCount(0)
  })
})
