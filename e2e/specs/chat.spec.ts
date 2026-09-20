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

  test('background run: a normal message under one line of provenance', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    const block = page.getByTestId('run-card')
    await expect(block).toHaveCount(1)
    // Provenance: which routine, when. A finished run says nothing about its state.
    await expect(block.getByText('morning-brief')).toBeVisible()
    await expect(block.getByText(/done ·/)).toHaveCount(0)
    // The answer reads like any other; the routine's prompt is behind a click.
    await expect(block.getByText('Three todos due today')).toBeVisible()
    await expect(block.getByText('Write the morning brief.')).toBeHidden()
    await block.getByRole('button', { name: 'prompt' }).click()
    await expect(block.getByText('Write the morning brief.')).toBeVisible()
    // The conversation's own messages stay outside the block.
    await expect(page.getByText('Court booking opens')).toBeVisible()
  })

  test('background runs with nothing to report fold into one line', async ({ page }) => {
    await openConversation(page, 'Activity steps')
    const quiet = page.getByTestId('quiet-runs')
    await expect(quiet).toHaveCount(1)
    await expect(quiet.getByText(/fixture-hook · 3 runs, nothing to report/)).toBeVisible()
    // The one that had something to say is a normal block, not folded.
    await expect(page.getByTestId('run-card').getByText('Filed under Projects.')).toBeVisible()
    await quiet.getByRole('button').first().click()
    await expect(quiet.getByText(/JavaScript Weekly/)).toBeVisible()
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
