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

  test('a routine is created like a chat: settings on top, its prompt sent from the composer', async ({ page }) => {
    await page.goto('routines')
    await page.getByRole('button', { name: 'New routine' }).click()
    await expect(page).toHaveURL(/\/routines\/new/)
    const fields = page.getByTestId('routine-fields')
    // The trigger is the one question up front; a schedule is the default.
    await expect(fields.getByRole('radio', { name: 'On a schedule' })).toHaveAttribute('aria-checked', 'true')
    await fields.getByLabel('Name', { exact: true }).fill('e2e-nightly')
    await fields.getByLabel('Schedule', { exact: true }).fill('0 3 * * *')
    // The expression is read back in words before saving.
    await expect(fields.getByText('daily at 03:00')).toBeVisible()
    // Standing alone, the thread's own notify mode applies; attached, the chat's.
    await expect(fields.getByLabel('Notifications')).toBeEnabled()
    await fields.getByLabel('Reports into').selectOption({ label: '📝 Blog publish · 🏗️ Projects' })
    await expect(fields.getByLabel('Notifications')).toBeDisabled()
    // No session knobs: every run starts fresh in the routine's thread.
    await expect(page.getByLabel('Only when idle')).toHaveCount(0)
    await expect(page.getByLabel('Use chat memory')).toHaveCount(0)
    // The prompt is written in the real composer, and sending creates it.
    const composer = page.getByPlaceholder('What should Jarvis do on each run?')
    await composer.fill('Tidy up.')
    await composer.press('Enter')
    // …and lands in its thread, the routine on top.
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
    const panel = page.getByTestId('routine-panel')
    await expect(panel).toContainText('daily at 03:00')
    await expect(panel).toContainText('reports into 📝 Blog publish')
    await expect(page.getByTestId('threads-group').getByText('e2e-nightly', { exact: true })).toBeVisible()

    // The prompt is edited in the composer too.
    await panel.getByRole('button', { name: /daily at 03:00/ }).click()
    await panel.getByRole('button', { name: 'Edit in the composer' }).click()
    const editor = page.getByTestId('prompt-editor')
    const box = editor.getByPlaceholder('What should Jarvis do on each run?')
    await expect(box).toHaveValue('Tidy up.')
    await box.fill('Tidy up the downloads.')
    await box.press('Enter')
    await expect(editor).toBeHidden()
    await expect(panel).toContainText('Tidy up the downloads.')

    // Leave the instance as found, so the specs do not depend on their order.
    page.once('dialog', (d) => d.accept())
    await panel.getByRole('button', { name: 'Delete routine' }).click()
    await expect(panel).toBeHidden()
  })

  test('a new routine without a name says so and keeps what was typed', async ({ page }) => {
    await page.goto('routines/new')
    const composer = page.getByPlaceholder('What should Jarvis do on each run?')
    await composer.fill('Do the thing.')
    await composer.press('Enter')
    await expect(page.getByRole('alert')).toHaveText('Give it a name')
    await expect(composer).toHaveValue('Do the thing.')
  })

  test('a webhook routine shows its link at the top of its thread', async ({ page }) => {
    await page.goto('routines?edit=00000000-0000-4000-8000-0000000000a1')
    const panel = page.getByTestId('routine-panel')
    await expect(panel).toContainText('when called')
    await expect(panel.getByText(/\/api\/hooks\/.+\/trigger/)).toBeVisible()
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
    await expect(page.getByTestId('routine-panel').getByLabel('Name', { exact: true })).toHaveValue('morning-brief')
  })
})
