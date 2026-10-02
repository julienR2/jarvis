import { test, expect, signIn, openConversation } from '../helpers'
import type { Page } from '@playwright/test'

/**
 * Threads from a passage, Slack-style: # beside Reply opens a panel next to
 * the chat; the thread exists from its first message, forked from the chat,
 * and is marked under the message it came from.
 */
async function selectParagraph(page: Page, text: string) {
  await page.getByText(text, { exact: false }).first().evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  })
}

test.describe('threads from a passage', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('# opens a thread beside the chat; its first message creates it, marked under the message', async ({ page }) => {
    await openConversation(page, 'Markdown showcase')
    const chatUrl = page.url()
    await selectParagraph(page, 'A paragraph with')
    await page.getByTestId('thread-selection').click()
    const panel = page.getByTestId('thread-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByText('A paragraph with bold, italic, inline code and a link.')).toBeVisible()
    // Nothing exists yet: no mark, no address.
    await expect(page.getByTestId('thread-marks')).toHaveCount(0)
    expect(page.url()).toBe(chatUrl)

    const box = panel.getByPlaceholder('Reply in a thread…')
    await box.fill('Can you shorten that?')
    await box.press('Enter')
    // Created: the panel shows the thread, the address names it, the chat marks it.
    await expect(page).toHaveURL(/\?thread=[0-9a-f-]+/)
    await expect(panel.getByText('Can you shorten that?')).toBeVisible()
    const mark = page.getByTestId('thread-marks').getByRole('button')
    await expect(mark).toContainText('A paragraph with bold')
    // Not in the sidebar's Threads: it lives with its chat.
    await expect(page.getByTestId('threads-group').getByText(/A paragraph with/)).toHaveCount(0)

    // Closed, then reopened from its mark.
    await panel.getByRole('button', { name: 'Close the thread' }).click()
    await expect(panel).toHaveCount(0)
    await expect(page).not.toHaveURL(/thread=/)
    await mark.click()
    await expect(page.getByTestId('thread-panel').getByText('Can you shorten that?')).toBeVisible()
  })

  test('in a chat with an app, a thread takes the app’s place while open', async ({ page }) => {
    await openConversation(page, 'Fixture app')
    const app = page.frameLocator('iframe').first()
    await expect(app.getByTestId('fixture-app')).toBeVisible()
    await selectParagraph(page, 'Done — it is in the preview pane.')
    await page.getByTestId('thread-selection').click()
    await expect(page.getByTestId('thread-panel')).toBeVisible()
    await expect(page.locator('iframe')).toHaveCount(0)
    await page.getByTestId('thread-panel').getByRole('button', { name: 'Close the thread' }).click()
    await expect(app.getByTestId('fixture-app')).toBeVisible()
  })
})
