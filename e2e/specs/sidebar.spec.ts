import { test, expect, signIn } from '../helpers'

test.describe('sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('sections and their conversations are listed', async ({ page }) => {
    for (const section of ['Fixtures', 'Daily', 'Projects']) {
      await expect(page.getByText(section).first()).toBeVisible()
    }
    for (const title of ['Markdown showcase', 'Activity steps', 'Morning brief', 'Fixture app']) {
      await expect(page.getByText(title).first()).toBeVisible()
    }
  })

  test('a chat row\'s ⋯ menu is the short one: move, rename, delete — no sharing', async ({ page }) => {
    const side = page.getByRole('complementary')
    await side.getByText('Markdown showcase').hover()
    await side.locator('button[title*="onversation options"]:visible').first().click()
    await expect(page.getByRole('button', { name: 'Move to topic' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit name' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Share conversation' })).toHaveCount(0)
  })

  test('new chat creates a conversation and opens it', async ({ page }) => {
    await page.getByText('New chat').click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
    await expect(page.getByPlaceholder('How can I help you today?')).toBeVisible()
  })
})
