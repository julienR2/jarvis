import { test, expect, signIn } from '../helpers'

/** The routines the fixtures own — what every count here is scoped to. */
const FIXTURE_RUNS = /morning-brief|new-year-wish|fixture-hook|reply-marta|publish-post/

test.describe('activity', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
    await page.goto('activity')
  })

  test('log: every run, newest first, grouped by day, with its one line', async ({ page }) => {
    // Fixture rows only, by name: next is also used by hand, and the log may hold more.
    const rows = page.getByTestId('run-row').filter({ hasText: FIXTURE_RUNS })
    // 10 seeded runs: two parked on the person, today's brief and the yearly cron's failure, the hook (once with news, three times quiet), yesterday's failed brief, a brief from 2 days ago
    await expect(rows).toHaveCount(10)
    // Grouped by day: the fixtures span several, so there are at least two day
    // headings. Not asserting 'Today' by name — right after midnight the runs
    // from "minutes ago" fall under Yesterday, and there is no Today group.
    expect(await page.getByRole('heading', { level: 2 }).count()).toBeGreaterThanOrEqual(2)
    await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible()
    // Newest first: the publish approval (6 min ago), the question (12), two quiet hook fires (20, 35), then the yearly cron's failure (45 min).
    await expect(rows.first().getByText('publish-post')).toBeVisible()
    await expect(rows.nth(4).getByText('new-year-wish')).toBeVisible()
    await expect(rows.filter({ hasText: 'morning-brief' }).first().getByText(/done · \d+ min/)).toBeVisible()
    await expect(page.getByText('Filed under Projects.')).toBeVisible()
  })

  test('log: a failed run shows its error, and offers a retry', async ({ page }) => {
    await page.getByRole('button', { name: 'Failed', exact: true }).click()
    const rows = page.getByTestId('run-row').filter({ hasText: FIXTURE_RUNS })
    await expect(rows).toHaveCount(2)
    const brief = rows.filter({ hasText: 'morning-brief' })
    await expect(brief).toHaveAttribute('data-status', 'error')
    await expect(brief.getByText(/PocketBase returned 401/)).toBeVisible()
    await expect(brief.getByRole('button', { name: /Retry/ })).toBeVisible()
  })

  test('log: filters narrow by kind, and a row opens its chat', async ({ page }) => {
    await page.getByRole('button', { name: 'Webhooks' }).click()
    const rows = page.getByTestId('run-row').filter({ hasText: FIXTURE_RUNS })
    // The hook's four runs and the publish approval — all webhooks, no cron.
    await expect(rows).toHaveCount(5)
    await expect(rows.filter({ hasText: 'morning-brief' })).toHaveCount(0)
    const hook = rows.filter({ hasText: 'fixture-hook' })
    await expect(hook).toHaveCount(4)
    await hook.first().getByRole('button', { name: /Activity steps/ }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000002$/)
  })

  test('routines: crons and webhooks in one list, with a working switch', async ({ page }) => {
    await page.getByRole('tab', { name: 'Routines' }).click()
    const rows = page.getByTestId('routine-row')
    // Each fixture routine exactly once, by exact name — other rows may exist.
    for (const name of ['morning-brief', 'new-year-wish', 'reply-marta', 'fixture-hook', 'publish-post']) {
      await expect(rows.filter({ has: page.getByText(name, { exact: true }) })).toHaveCount(1)
    }
    await expect(rows.filter({ hasText: 'morning-brief' }).getByText('daily at 05:30')).toBeVisible()
    const hook = rows.filter({ hasText: 'fixture-hook' })
    await expect(hook.getByText('when called')).toBeVisible()
    await expect(hook.getByTitle('Copy trigger URL')).toBeVisible()
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

    // Leave the instance as found: the suite shares it with whoever uses next.
    page.once('dialog', (d) => d.accept())
    await row.getByTitle('Delete this cron').click()
    await expect(row).toBeHidden()
  })

  test('the old /crons address still lands, form open', async ({ page }) => {
    await page.goto('crons?edit=00000000-0000-4000-8000-0000000000c1')
    await expect(page).toHaveURL(/\/activity\?/)
    await expect(page.getByRole('heading', { name: 'Edit cron' })).toBeVisible()
    await expect(page.getByPlaceholder(/Name/)).toHaveValue('morning-brief')
  })

  test('sidebar: the entry shows one dot, the most urgent — amber while something waits on you', async ({ page }) => {
    // Two runs wait for an answer, the yearly cron's run failed this morning,
    // nothing is running: amber wins over red, and there is never more than one.
    await expect(page.getByTestId('activity-waiting')).toHaveCount(1)
    await expect(page.getByTestId('activity-failed')).toHaveCount(0)
    await expect(page.getByTestId('activity-running')).toHaveCount(0)
  })
})
