import { test, expect, signIn } from '../helpers'

/**
 * The Routines page: crons and webhooks as one list of things Jarvis runs
 * without you. Fixtures: morning-brief (daily, paused), new-year-wish (yearly,
 * on), reply-marta (weekdays, paused), fixture-hook and publish-post (links).
 * What each routine did opens under it, a way into its thread (threads.spec).
 */
test.describe('routines', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('one list for crons and webhooks, each saying when it runs and where it posts', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Routines/ }).click()
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
    // The rarer actions sit behind ⋯; the switch closes every row.
    await hook.getByRole('button', { name: 'More for fixture-hook' }).click()
    await expect(page.getByRole('button', { name: 'Copy its link' })).toBeVisible()
    await page.keyboard.press('Escape')
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

  test('a new routine is a thread whose card is the form', async ({ page }) => {
    await page.goto('routines')
    await page.getByRole('button', { name: 'New routine' }).click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
    await expect(page.getByTestId('threads-group').getByText('New routine', { exact: true })).toBeVisible()
    const card = page.getByTestId('routine-card')
    // Missing pieces are said, not guessed.
    await card.getByRole('button', { name: 'Create routine' }).click()
    await expect(card.getByRole('alert')).toHaveText('Give it a name.')
    await card.getByLabel('Name').fill('e2e-nightly')
    await card.getByRole('button', { name: 'How often' }).click()
    await page.getByRole('option', { name: 'On weekdays' }).click()
    await card.getByLabel('Time').fill('03:00')
    await card.getByLabel('Prompt').fill('Tidy up.')
    await card.getByRole('button', { name: 'Create routine' }).click()
    // The thread is now the routine's: named after it; the card leaves the
    // transcript for the chip in the title bar.
    await expect(page.getByRole('heading', { name: '# e2e-nightly' }).first()).toBeAttached()
    const chip = page.getByTestId('routine-chip').locator('visible=true')
    await expect(chip).toContainText('weekdays at 03:00')
    await expect(page.getByRole('main').getByTestId('routine-card')).toHaveCount(0)

    // Edited from the chip's card: Save appears with a change, and a dropdown
    // opened inside it doesn't close it.
    await chip.click()
    const edit = page.getByTestId('routine-card')
    await edit.getByRole('button', { name: 'Reports into' }).click()
    await page.getByRole('option', { name: /Surf/ }).click()
    await edit.getByLabel('Prompt').fill('Tidy up the downloads.')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit.getByText('Up to date')).toBeVisible()

    // Leave the instance as found.
    page.once('dialog', (d) => d.accept())
    await edit.getByRole('button', { name: 'More' }).click()
    await page.getByRole('button', { name: 'Delete routine' }).click()
    await expect(page.getByTestId('routine-chip')).toHaveCount(0)
  })

  test('discarding a new routine throws the draft away', async ({ page }) => {
    await page.goto('routines')
    await page.getByRole('button', { name: 'New routine' }).click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
    const id = new URL(page.url()).pathname.split('/').pop()!
    await page.getByTestId('routine-card').getByRole('button', { name: 'Discard' }).click()
    await expect(page).toHaveURL(/\/routines$/)
    await expect(page.getByTestId('threads-group').getByText('New routine', { exact: true })).toHaveCount(0)
    // Gone, not merely hidden.
    const res = await page.request.get(`api/conversations/${id}`, { headers: { Authorization: `Bearer ${process.env.E2E_TOKEN}` } })
    expect(res.status()).toBe(404)
  })

  test('a draft put away from the sidebar is deleted too', async ({ page }) => {
    await page.goto('routines/new')
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
    const id = new URL(page.url()).pathname.split('/').pop()!
    const row = page.getByTestId('threads-group').getByText('New routine', { exact: true })
    await row.hover()
    await page.getByRole('button', { name: 'Put away New routine' }).click()
    await expect(row).toHaveCount(0)
    await expect.poll(async () => (await page.request.get(`api/conversations/${id}`, { headers: { Authorization: `Bearer ${process.env.E2E_TOKEN}` } })).status()).toBe(404)
  })

  test('a row opens the routine’s thread', async ({ page }) => {
    await page.goto('routines')
    await page.getByTestId('routine-row').filter({ hasText: 'price-watch' }).getByText('price-watch', { exact: true }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000011$/)
    await expect(page.getByTestId('routine-chip').locator('visible=true')).toContainText('daily at 09:00')
  })

  test('a webhook routine shows its link on its card', async ({ page }) => {
    await page.goto('routines?edit=00000000-0000-4000-8000-0000000000a1')
    const card = page.getByTestId('routine-card')
    await expect(card.getByText(/\/api\/hooks\/.+\/trigger/)).toBeVisible()
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
    // Editing a routine happens in its thread.
    await expect(page.getByTestId('routine-card').locator('visible=true').first().getByLabel('Prompt')).toHaveValue('Write the morning brief.')
  })
})
