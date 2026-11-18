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
    // Reached from the Settings menu.
    await page.goto('')
    await page.locator('aside').getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('menuitem', { name: /Routines/ }).click()
    await expect(page).toHaveURL(/\/routines$/)
    // Laid out as a topic: what routines are, then those waiting for you, then the list.
    await expect(page.getByTestId('routines-intro')).toContainText('What Jarvis does on its own')
    // Reply to Marta: the one waiting routine no spec ever answers.
    await expect(page.getByTestId('routines-waiting')).toContainText('Send this reply to Marta?')
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
    // new-year-wish: no other test reads whether it is on, and tests run in
    // parallel — toggling morning-brief raced the ones that expect it paused.
    await page.goto('routines')
    const sw = page.getByRole('switch', { name: 'Pause new-year-wish' })
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await sw.click()
    await expect(page.getByRole('switch', { name: 'Resume new-year-wish' })).toHaveAttribute('aria-checked', 'false')
    // Leave it as found.
    await page.getByRole('switch', { name: 'Resume new-year-wish' }).click()
    await expect(page.getByRole('switch', { name: 'Pause new-year-wish' })).toBeVisible()
  })

  test('a new routine starts in the composer: its settings above, its message below; the chip edits it after', async ({ page }) => {
    await page.goto('routines')
    await page.getByRole('button', { name: 'New routine' }).click()
    // Today's composer, the schedule open.
    await expect(page).toHaveURL(/\?routine=cron$/)
    const strip = page.getByTestId('routine-strip')
    await expect(strip).toContainText('A routine on a schedule')
    await strip.getByRole('button', { name: 'How often' }).click()
    await page.getByRole('option', { name: 'On weekdays' }).click()
    await strip.getByLabel('Time').fill('03:00')
    await strip.getByLabel('Routine name').fill('e2e-nightly')
    // Missing pieces are said, not guessed.
    const box = page.getByPlaceholder('What should Jarvis do on each run?')
    await box.press('Enter')
    await expect(strip.getByRole('alert')).toHaveText('Say what Jarvis should do on each run.')
    await box.fill('Tidy up.')
    await box.press('Enter')
    // Its own chat now, named after it, the chip in the title bar.
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
    await expect(page.getByRole('heading', { name: 'e2e-nightly' }).first()).toBeAttached()
    const chip = page.getByTestId('routine-chip').locator('visible=true')
    await expect(chip).toContainText('weekdays at 03:00')

    // Edited from the chip's card: Save appears with a change, and a dropdown
    // opened inside it doesn't close it.
    await chip.click()
    const edit = page.getByTestId('routine-card')
    await edit.getByRole('button', { name: 'Under' }).click()
    await page.getByRole('option', { name: /Surf/ }).first().click()
    await edit.getByLabel('Prompt').fill('Tidy up the downloads.')
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit.getByText('Up to date')).toBeVisible()

    // Leave the instance as found.
    page.once('dialog', (d) => d.accept())
    await edit.getByRole('button', { name: 'More' }).click()
    await page.getByRole('button', { name: 'Delete routine' }).click()
    await expect(page.getByTestId('routine-chip')).toHaveCount(0)
  })

  test('a new thread can be a routine too: it hangs under the chat, a webhook with a thread per call', async ({ page }) => {
    await page.goto('c/00000000-0000-4000-8000-00000000000f')
    await page.locator('[data-testid="threads-pill"]:visible').click()
    await page.getByTestId('threads-popover').getByRole('button', { name: /New thread/ }).click()
    const panel = page.getByTestId('thread-panel')
    await panel.getByTestId('routine-pills').getByRole('button', { name: 'When called' }).click()
    const strip = panel.getByTestId('routine-strip')
    await strip.getByRole('switch', { name: 'A new thread for each call' }).click()
    await strip.getByLabel('Routine name').fill('e2e-inbox')
    const box = panel.getByPlaceholder('What should Jarvis do on each run?')
    await box.fill('Sort what comes in.')
    await box.press('Enter')
    // Opened beside its chat, as a thread of it.
    await expect(page).toHaveURL(/\?thread=[0-9a-f-]+/)
    const headers = { Authorization: `Bearer ${process.env.E2E_TOKEN}` }
    const hooks = await (await page.request.get('api/webhooks', { headers })).json() as { id: string; name: string; conversation_id: string | null; thread_per_fire: number }[]
    const hook = hooks.find((h) => h.name === 'e2e-inbox')!
    expect(hook.conversation_id).toBe('00000000-0000-4000-8000-00000000000f')
    expect(hook.thread_per_fire).toBe(1)
    await page.request.delete(`api/webhooks/${hook.id}`, { headers })
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
