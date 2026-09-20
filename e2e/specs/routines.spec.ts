import { test, expect, signIn } from '../helpers'

/**
 * The Routines page: crons and webhooks as one list of things Jarvis runs
 * without you. Fixtures: morning-brief (daily, paused), new-year-wish (yearly,
 * on), reply-marta (weekdays, paused), fixture-hook and publish-post (links).
 * What the routines DID is not here — that lives in the chats and on Today.
 */
test.describe('routines', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('one list for crons and webhooks, each saying when it runs and where it posts', async ({ page }) => {
    await page.getByRole('button', { name: 'Routines' }).click()
    await expect(page).toHaveURL(/\/routines$/)
    const rows = page.getByTestId('routine-row')
    // Each fixture routine exactly once, by exact name — other rows may exist.
    for (const name of ['morning-brief', 'new-year-wish', 'reply-marta', 'fixture-hook', 'publish-post']) {
      await expect(rows.filter({ has: page.getByText(name, { exact: true }) })).toHaveCount(1)
    }
    const brief = rows.filter({ hasText: 'morning-brief' })
    await expect(brief.getByText('daily at 05:30')).toBeVisible()
    await expect(brief.getByText('paused')).toBeVisible()
    await expect(brief.getByRole('button', { name: /Morning brief/ })).toBeVisible()
    const hook = rows.filter({ hasText: 'fixture-hook' })
    await expect(hook.getByText('when called')).toBeVisible()
    await expect(hook.getByTitle('Copy its link')).toBeVisible()
    // No run log on this page any more.
    await expect(page.getByRole('tab')).toHaveCount(0)
  })

  test('the switch pauses and resumes a routine', async ({ page }) => {
    await page.goto('routines')
    const sw = page.getByRole('switch', { name: 'Resume morning-brief' })
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect(page.getByRole('switch', { name: 'Pause morning-brief' })).toHaveAttribute('aria-checked', 'true')
    // Back off — a live cron on a throwaway instance still costs.
    await page.getByRole('switch', { name: 'Pause morning-brief' }).click()
    await expect(page.getByRole('switch', { name: 'Resume morning-brief' })).toBeVisible()
  })

  test('a routine is created from one form, then edited from its gear', async ({ page }) => {
    await page.goto('routines')
    await page.getByRole('button', { name: 'New routine' }).click()
    const form = page.getByTestId('routine-form')
    await expect(form.getByRole('heading', { name: 'New routine' })).toBeVisible()
    // The trigger is the one question up front; a schedule is the default.
    await expect(form.getByRole('radio', { name: 'On a schedule' })).toHaveAttribute('aria-checked', 'true')
    await form.getByLabel('Name', { exact: true }).fill('e2e-nightly')
    await form.getByLabel('Schedule', { exact: true }).fill('0 3 * * *')
    // The expression is read back in words before saving.
    await expect(form.getByText('daily at 03:00')).toBeVisible()
    await form.getByLabel('Prompt', { exact: true }).fill('Tidy up.')
    // Posts into a fixture chat, picked from the list.
    await form.getByLabel('Posts into').selectOption({ label: '📝 Blog publish · 🏗️ Projects' })
    await form.getByLabel('Enabled').uncheck()
    await form.getByRole('button', { name: 'Create' }).click()
    await expect(form).toBeHidden()
    const row = page.getByTestId('routine-row').filter({ hasText: 'e2e-nightly' })
    await expect(row).toBeVisible()
    await expect(row.getByText('daily at 03:00')).toBeVisible()
    await expect(row.getByRole('button', { name: /Blog publish/ })).toBeVisible()

    await row.getByTitle('Edit this routine').click()
    await expect(page.getByRole('heading', { name: 'Edit routine' })).toBeVisible()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('e2e-nightly')
    // The trigger is fixed once it exists.
    await expect(page.getByTestId('routine-form').getByText('on a schedule')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('routine-form')).toBeHidden()

    // Leave the instance as found: the suite shares it with whoever uses next.
    page.once('dialog', (d) => d.accept())
    await row.getByTitle('Delete this routine').click()
    await expect(row).toBeHidden()
  })

  test('a webhook routine shows its link in the form', async ({ page }) => {
    await page.goto('routines?edit=00000000-0000-4000-8000-0000000000a1')
    const form = page.getByTestId('routine-form')
    await expect(form.getByRole('heading', { name: 'Edit routine' })).toBeVisible()
    await expect(form.getByText('when its link is called')).toBeVisible()
    await expect(form.getByText(/\/api\/hooks\/.+\/trigger/)).toBeVisible()
  })

  test('filtered to one chat from its ⋯ menu, and back to all', async ({ page }) => {
    await page.goto('routines?conversation_id=00000000-0000-4000-8000-000000000003')
    const rows = page.getByTestId('routine-row')
    await expect(rows.filter({ hasText: 'morning-brief' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'fixture-hook' })).toHaveCount(0)
    await page.getByTitle('Show every routine').click()
    await expect(rows.filter({ hasText: 'fixture-hook' })).toHaveCount(1)
  })

  test('the old addresses still land: /activity, /crons?edit=', async ({ page }) => {
    await page.goto('activity?tab=routines')
    await expect(page).toHaveURL(/\/routines$/)
    await page.goto('crons?edit=00000000-0000-4000-8000-0000000000c1')
    await expect(page).toHaveURL(/\/routines/)
    await expect(page.getByRole('heading', { name: 'Edit routine' })).toBeVisible()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('morning-brief')
  })
})
