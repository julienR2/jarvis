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
    const inbox = page.getByTestId('today-inbox')
    const waiting = inbox.locator('[data-testid="today-row"][data-status="needs_you"]')
    await expect(waiting.first()).toBeVisible()
    // Waiting chats are "action" cards, like the failure that needs a retry;
    // both come before anything merely unread.
    const failed = inbox.locator('[data-testid="today-row"][data-status="error"]').first()
    await expect(failed).toHaveAttribute('data-reason', 'action')
    const unread = inbox.locator('[data-testid="today-row"][data-reason="unread"]').first()
    const [w, u] = await Promise.all([waiting.first().boundingBox(), unread.boundingBox()])
    expect(w && u && w.y < u.y).toBeTruthy()
    const marta = waiting.filter({ hasText: 'reply-marta' })
    // Open by default: the embedded chat and its options are right there.
    await expect(marta.getByRole('button', { name: 'Send it' })).toBeVisible()
    await expect(marta.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    // Collapsed, the header carries a one-line hint of the question instead.
    await marta.getByRole('button', { expanded: true }).click()
    await expect(marta.getByRole('button', { name: 'Send it' })).toHaveCount(0)
    await expect(marta.getByText('Send this reply to Marta?', { exact: true })).toBeVisible()
    await expect(page.getByTestId('activity-waiting')).toBeVisible()
    await expect(page.getByTestId('activity-failed')).toBeHidden()
  })

  test('a question in an ordinary chat (no run) shows on Today and answers from the composer', async ({ page }) => {
    // Today lists it even though the runs feed knows nothing about it.
    const row = page.getByTestId('today-inbox').getByTestId('today-row').filter({ hasText: 'Trip idea' })
    await expect(row).toHaveAttribute('data-status', 'needs_you')
    // Open by default, the options are right there.
    await expect(row.getByRole('button', { name: 'Beach' })).toBeVisible()
    await row.getByRole('button', { name: 'Open', exact: true }).click()
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
    await expect(page.getByTestId('today-inbox')).toBeVisible()
    await expect(page.locator('[data-testid="today-row"][data-status="needs_you"]').filter({ hasText: 'publish-post' })).toHaveCount(0)
  })
})
