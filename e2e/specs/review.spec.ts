import { test, expect, signIn, openConversation } from '../helpers'
import type { Page } from '@playwright/test'

/**
 * A text Jarvis wants approved before it goes out (its review_text tool).
 * Fixture: "Running late", a chat parked on a WhatsApp to Sam. No engine holds
 * the prompt, so every answer here is intercepted — answering for real would
 * drop the fixture for the other tests.
 */
const DRAFT = "Hey Sam! Running about 15 minutes late, sorry — go ahead and order without me if you're hungry."

async function captureAnswer(page: Page) {
  const sent: { body: Record<string, unknown> | null } = { body: null }
  await page.route('**/conversations/*/answer', async (route) => {
    sent.body = route.request().postDataJSON()
    await route.fulfill({ json: { answered: true } })
  })
  return sent
}

test.describe('review before sending', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('the draft heads the composer, editable, and Send hands back the edited text', async ({ page }) => {
    await openConversation(page, 'Running late')
    const card = page.getByTestId('review-card')
    await expect(card).toBeVisible()
    await expect(card.getByText('Running late for lunch')).toBeVisible()
    // Where it goes is shown in full, apart from the text.
    await expect(card.getByTestId('draft-envelope')).toContainText('Sam (WhatsApp)')
    const text = card.getByRole('textbox', { name: 'Text to send' })
    await expect(text).toHaveValue(DRAFT)
    // The composer's own input is the other answer: what to change.
    await expect(page.getByPlaceholder('Or tell Jarvis what to change…')).toBeVisible()
    // Untouched, there is nothing to undo.
    await expect(card.getByRole('button', { name: 'Undo edits' })).toHaveCount(0)

    await text.fill('Hey Sam! Running 15 minutes late, sorry. Order without me!')
    await expect(card.getByRole('button', { name: 'Undo edits' })).toBeVisible()
    const sent = await captureAnswer(page)
    await card.getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => sent.body).toMatchObject({
      request_id: 'req_fixture_review',
      behavior: 'allow',
      text: 'Hey Sam! Running 15 minutes late, sorry. Order without me!',
    })
  })

  test('undo brings back Jarvis\'s version, and Send approves it as is', async ({ page }) => {
    await openConversation(page, 'Running late')
    const card = page.getByTestId('review-card')
    const text = card.getByRole('textbox', { name: 'Text to send' })
    await text.fill('something else')
    await card.getByRole('button', { name: 'Undo edits' }).click()
    await expect(text).toHaveValue(DRAFT)
    const sent = await captureAnswer(page)
    await text.press('Control+Enter')
    await expect.poll(() => sent.body).toMatchObject({ behavior: 'allow', text: DRAFT })
  })

  test('typing in the composer asks for changes; Discard declines without words', async ({ page }) => {
    await openConversation(page, 'Running late')
    const sent = await captureAnswer(page)
    const input = page.getByPlaceholder('Or tell Jarvis what to change…')
    await input.fill('Make it shorter')
    await input.press('Enter')
    await expect.poll(() => sent.body).toMatchObject({ behavior: 'deny', message: 'Make it shorter' })

    sent.body = null
    await page.getByTestId('review-card').getByRole('button', { name: 'Discard' }).click()
    await expect.poll(() => sent.body).toMatchObject({ behavior: 'deny' })
    expect(sent.body?.message ?? '').toBe('')
  })

  test('Polish hands the text back to look over, not to send', async ({ page }) => {
    await openConversation(page, 'Running late')
    const card = page.getByTestId('review-card')
    await card.getByRole('textbox', { name: 'Text to send' }).fill('hey sam running late order without me')
    const sent = await captureAnswer(page)
    await card.getByRole('button', { name: 'Polish' }).click()
    await expect.poll(() => sent.body).toMatchObject({
      behavior: 'allow',
      polish: true,
      text: 'hey sam running late order without me',
    })
  })

  test('an approved draft reads as a card in the bubble, with where it went', async ({ page }) => {
    await openConversation(page, 'Running late')
    const approved = page.getByTestId('approved-draft')
    await expect(approved).toBeVisible()
    await expect(approved).toContainText('Approved')
    const envelope = approved.getByTestId('draft-envelope')
    await expect(envelope).toContainText('landlord@example.com')
    await expect(envelope).toContainText('Signed lease and key pickup')
    await expect(envelope).toContainText('lease-signed.pdf')
    await expect(envelope).toContainText('inventory.pdf')
    // The quote markers of the record are not drawn.
    await expect(approved).toContainText('Please find the signed lease attached')
    await expect(approved).not.toContainText('> Hello')
  })

  test('today shows the draft in its card, editable there too', async ({ page }) => {
    const row = page.getByTestId('today-inbox').getByTestId('today-row').filter({ hasText: 'Running late' })
    await expect(row).toHaveAttribute('data-status', 'needs_you')
    await expect(row.getByRole('textbox', { name: 'Text to send' })).toHaveValue(DRAFT)
    await expect(row.getByRole('button', { name: 'Send' })).toBeVisible()
  })
})
