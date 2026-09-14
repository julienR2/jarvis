import { test, expect, signIn, openConversation } from '../helpers'

test.describe('chat rendering', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('markdown: headings, table, code, lists', async ({ page }) => {
    await openConversation(page, 'Markdown showcase')
    await expect(page.getByRole('heading', { name: 'Headings, lists, code' })).toBeVisible()
    await expect(page.locator('table')).toBeVisible()
    await expect(page.locator('pre code')).toContainText('const answer = 42')
    await expect(page.getByText('nested')).toBeVisible()
    await expect(page.getByRole('link', { name: 'link' })).toHaveAttribute('href', 'https://example.com')
  })

  test('activity: folded to one line, notes on a click, steps on another, a note folds it back', async ({ page }) => {
    await openConversation(page, 'Activity steps')
    // The answer is the point; the machinery is one line.
    await expect(page.getByText('10 photos')).toBeVisible()
    const line = page.getByRole('button', { name: /3 steps · 2 notes/ })
    await expect(line).toBeVisible()
    await expect(page.getByRole('button', { name: /^2 steps$/ })).toBeHidden()

    // Unfold: the notes in full, tool calls still folded.
    await line.click()
    const note = page.getByText('Twelve files, but two are duplicates by hash')
    await expect(note).toBeVisible()
    const steps = page.getByRole('button', { name: /^2 steps$/ })
    await expect(steps).toBeVisible()
    await expect(page.getByText('ls /workspace/gallery/2026-09')).toBeHidden()

    // Steps keep their own toggle…
    await steps.click()
    await expect(page.getByText('ls /workspace/gallery/2026-09')).toBeVisible()

    // …and a press on a note folds everything back to the line.
    await note.click()
    await expect(line).toBeVisible()
    await expect(note).toBeHidden()
  })

  test('background run: one card — what ran, how it went, its one paragraph', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    const card = page.getByTestId('run-card')
    await expect(card).toHaveCount(1)
    await expect(card.getByText('Cron: morning-brief')).toBeVisible()
    await expect(card.getByText(/done · (\d+s|\d+ min)/)).toBeVisible()
    // The summary is the body; the automation's prompt and steps are behind details.
    await expect(card.getByText('Three todos due today')).toBeVisible()
    await expect(card.getByText('Write the morning brief.')).toBeHidden()
    await card.getByRole('button', { name: /details · 2 messages/ }).click()
    await expect(card.getByText('Write the morning brief.')).toBeVisible()
    // The conversation's own messages stay outside the card.
    await expect(page.getByText('Court booking opens')).toBeVisible()
  })

  test("background run: the gear opens the cron's definition in edit mode", async ({ page }) => {
    await openConversation(page, 'Morning brief')
    await page.getByTestId('run-card').getByTitle("Open this cron's settings").click()
    await expect(page).toHaveURL(/\/activity\?tab=routines/)
    await expect(page.getByRole('heading', { name: 'Edit cron' })).toBeVisible()
    await expect(page.getByPlaceholder(/Name/)).toHaveValue('morning-brief')
  })

  test('app pane: the fixture app renders beside the chat', async ({ page }) => {
    await openConversation(page, 'Fixture app')
    const frame = page.frameLocator('iframe[title="App preview"]')
    await expect(frame.getByTestId('fixture-app')).toBeVisible()
  })
})
