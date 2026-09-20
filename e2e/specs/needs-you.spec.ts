import { test, expect, signIn, openConversation } from '../helpers'

/**
 * Jarvis waiting on you. Fixtures: the `reply-marta` cron parked on an
 * AskUserQuestion ("Send this reply to Marta?", two options) and the
 * `publish-post` webhook parked on a Bash approval. Neither has an engine
 * session behind it, so answering drops the question and closes the run as
 * lost — the honest outcome on a throwaway instance, and what the last test
 * checks. It answers the approval, never the question, so the other tests keep
 * their fixture whatever the order.
 */
test.describe('needs you', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('the chat shows the question as a card with its options, and the run as waiting', async ({ page }) => {
    await openConversation(page, 'Reply to Marta')
    // Today draws its own compact cards; wait for the route to have swapped.
    await expect(page.getByTestId('answer-card')).toHaveCount(1)
    const card = page.getByTestId('answer-card')
    await expect(card).toBeVisible()
    await expect(card.getByText('Send this reply to Marta?')).toBeVisible()
    await expect(card.getByRole('button', { name: 'Send it' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Edit first' })).toBeVisible()
    // Free text is the composer itself, so dictation and files come with it.
    const composerInput = page.getByPlaceholder('Or type your own answer…')
    await expect(composerInput).toBeVisible()
    // Picking an option sets it as the input's value — pick and type are one
    // field — and the composer's own Send (no separate Answer button) confirms.
    await card.getByRole('button', { name: 'Edit first' }).click()
    await expect(card.getByRole('button', { name: 'Edit first' })).toHaveAttribute('aria-pressed', 'true')
    await expect(composerInput).toHaveValue('Edit first')
    await expect(page.getByTitle('Answer', { exact: true })).toBeEnabled()
    await expect(card.getByRole('button', { name: 'Answer' })).toHaveCount(0)
    // Tapping the chosen option again clears it and the input, nothing sent.
    await card.getByRole('button', { name: 'Edit first' }).click()
    await expect(card.getByRole('button', { name: 'Edit first' })).toHaveAttribute('aria-pressed', 'false')
    await expect(composerInput).toHaveValue('')
    await expect(card).toBeVisible()
    await expect(page.getByPlaceholder('How can I help you today?')).toBeHidden()
    // The run's provenance line says so too.
    const run = page.getByTestId('run-card')
    await expect(run.getByText('waiting for you', { exact: true })).toBeVisible()
    // The question is the head of the composer: same box, options above the input.
    const composer = page.getByPlaceholder('Or type your own answer…')
    const [c, o] = await Promise.all([card.boundingBox(), composer.boundingBox()])
    expect(c && o && c.y < o.y && o.y - (c.y + c.height) < 80).toBeTruthy()
  })

  test('today lists what waits, first, with the answer inline — and the sidebar dot goes amber', async ({ page }) => {
    const needs = page.getByTestId('today-needs')
    await expect(needs.getByRole('heading', { name: /Needs you/ })).toBeVisible()
    const waiting = needs.locator('[data-testid="today-row"][data-status="needs_you"]')
    await expect(waiting.first()).toBeVisible()
    // Above the failure that needs a retry.
    const failed = needs.locator('[data-testid="today-row"][data-status="error"]').first()
    const [w, f] = await Promise.all([waiting.first().boundingBox(), failed.boundingBox()])
    expect(w && f && w.y < f.y).toBeTruthy()
    const marta = waiting.filter({ hasText: 'reply-marta' })
    // Collapsed by default: the header carries a one-line hint of the question,
    // and the embedded chat is not mounted yet.
    await expect(marta.getByText('Send this reply to Marta?', { exact: true })).toBeVisible()
    await expect(marta.getByTestId('answer-card')).toHaveCount(0)
    await expect(marta.getByRole('button', { name: 'Open' })).toBeVisible()
    // Expanding reveals the embedded chat and its options.
    await marta.getByText('reply-marta').click()
    await expect(marta.getByRole('button', { name: 'Send it' })).toBeVisible()
    await expect(page.getByTestId('activity-waiting')).toBeVisible()
    await expect(page.getByTestId('activity-failed')).toBeHidden()
  })

  test('a question in an ordinary chat (no run) shows on Today and answers from the composer', async ({ page }) => {
    // Today lists it even though the runs feed knows nothing about it.
    const row = page.getByTestId('today-needs').getByTestId('today-row').filter({ hasText: 'Trip idea' })
    await expect(row).toHaveAttribute('data-status', 'needs_you')
    // Collapsed: the question shows as a hint; expand for the options.
    await expect(row.getByText('Beach or city for this trip?', { exact: true })).toBeVisible()
    await expect(row.getByTestId('answer-card')).toHaveCount(0)
    await row.getByText('Trip idea').click()
    await expect(row.getByRole('button', { name: 'Beach' })).toBeVisible()
    await row.getByRole('button', { name: 'Open' }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000007$/)
    // The composer carries the question; picking a chip fills the input.
    const card = page.getByTestId('answer-card')
    await expect(card.getByText('Beach or city for this trip?')).toBeVisible()
    const composerInput = page.getByPlaceholder('Or type your own answer…')
    await card.getByRole('button', { name: 'City' }).click()
    await expect(composerInput).toHaveValue('City')
    await expect(page.getByTitle('Answer', { exact: true })).toBeEnabled()
  })

  test('the chat title bar shows the parked run and offers Stop', async ({ page }) => {
    await openConversation(page, 'Reply to Marta')
    const pill = page.getByRole('main').getByTestId('routines-pill').locator('visible=true').first()
    await expect(pill).toContainText('1 running')
    await pill.click()
    const pop = page.getByTestId('routines-popover')
    await expect(pop.getByText('waiting for you')).toBeVisible()
    await expect(pop.getByRole('button', { name: /Stop/ })).toBeVisible()
  })

  test('a tool call waits for an approval; deciding clears it everywhere', async ({ page }) => {
    await openConversation(page, 'Blog publish')
    await expect(page.getByTestId('answer-card')).toHaveCount(1)
    const card = page.getByTestId('answer-card')
    await expect(card.getByText(/Approve Bash: Push the post/)).toBeVisible()
    // An approval leaves the composer alone: typing there still talks to Jarvis.
    await expect(page.getByPlaceholder('How can I help you today?')).toBeVisible()
    await expect(card.getByText('git push origin main')).toBeVisible()
    await card.getByRole('button', { name: 'Deny' }).click()
    const reason = card.getByPlaceholder(/Why not/)
    await reason.fill('Not before the typo fix')
    await reason.press('Enter')
    // No engine session holds this prompt on a throwaway instance: the backend
    // says so, drops the question and closes the run as lost.
    await expect(page.getByText(/no longer waiting for this/)).toBeVisible()
    await expect(card).toBeHidden()
    await expect(page.getByTestId('run-card').getByText('interrupted')).toBeVisible()
    await page.goto('./')
    await expect(page.getByTestId('today-needs').locator('[data-testid="today-row"][data-status="needs_you"]').filter({ hasText: 'publish-post' })).toHaveCount(0)
  })
})
