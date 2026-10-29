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

  test('a topic entry is as tall as a chat row', async ({ page }) => {
    const side = page.getByRole('complementary')
    const topic = side.getByRole('button', { name: /Projects/ }).and(side.locator('[title="Open the topic"]')).locator('xpath=..')
    const chat = side.getByText('Markdown showcase', { exact: true }).locator('xpath=..')
    const [t, c] = await Promise.all([topic.boundingBox(), chat.boundingBox()])
    expect(t && c).toBeTruthy()
    expect(Math.abs(t!.height - c!.height)).toBeLessThan(0.5)
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

  test('a topic\'s ⋯ menu starts a chat in it; routines are not there', async ({ page }) => {
    const side = page.getByRole('complementary')
    await side.getByTitle('Open the topic').filter({ hasText: 'Projects' }).hover()
    await side.locator('button[title="Topic options"]:visible').first().click()
    await expect(page.getByRole('button', { name: 'Routines' })).toHaveCount(0)
    await page.getByRole('button', { name: 'New chat' }).last().click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
    const id = page.url().match(/\/c\/([0-9a-f-]{36})$/)![1]
    await page.getByTitle('Open the topic').filter({ hasText: 'Projects' }).click()
    await expect(page.getByTestId('topic-chats').getByTestId('topic-chat').filter({ hasText: 'New conversation' }).first()).toBeVisible()
    // Leave the instance as found.
    await page.goto(`c/${id}`)
    await page.getByRole('main').locator('button[title*="onversation options"]:visible').first().click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  })

  test('new chat is Today with the composer focused — no conversation is created', async ({ page }) => {
    await page.goto('c/00000000-0000-4000-8000-000000000001')
    await expect(page.getByRole('complementary').getByText('Markdown showcase')).toBeVisible()
    const before = await page.getByRole('complementary').locator('[class*="cursor-pointer"]').count()
    await page.getByText('New chat').click()
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/)
    await expect(page.getByPlaceholder('How can I help you today?')).toBeFocused()
    await expect(page.getByRole('complementary').locator('[class*="cursor-pointer"]')).toHaveCount(before)
  })
})
