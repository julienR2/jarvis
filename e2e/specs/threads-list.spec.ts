import { test, expect, signIn, openConversation } from '../helpers'

/**
 * A chat's threads, without scrolling for them: the # pill in the title bar
 * lists them (active first, the rest under Archived), a chip above the
 * composer says when one answered, and each opens as a tab of the side pane.
 * Fixture "🗂️ Trip planning": "Wine cellars" answered after it was last read;
 * "Coast road" has not moved for ten days.
 */
test.describe('the threads of a chat', () => {
  test.describe.configure({ mode: 'serial' })
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('a side chat with a reply you have not seen shows under its chat in the sidebar', async ({ page }) => {
    await page.goto('')
    const sidebar = page.locator('aside')
    const nested = sidebar.getByText('Wine cellars', { exact: true })
    await expect(nested).toBeVisible()
    // Nothing new in the other one: it stays in the chat's list.
    await expect(sidebar.getByText('Coast road', { exact: true })).toHaveCount(0)
    // (Opening it is left to the tests below, which need its news unread.)
  })

  test('the pill lists the active threads, the stale one under Archived; news shows above the composer', async ({ page }) => {
    await openConversation(page, 'Trip planning')
    const news = page.getByTestId('thread-news')
    await expect(news).toContainText('Wine cellars')
    await expect(news).toContainText('1 new')

    await page.locator('[data-testid="threads-pill"]:visible').click()
    const list = page.getByTestId('threads-popover')
    await expect(list.getByTestId('thread-row')).toHaveCount(1)
    await expect(list.getByTestId('thread-row')).toContainText('Wine cellars')
    await expect(list.getByTestId('thread-row')).toContainText('Three days: Ribeira')
    await list.getByRole('button', { name: /Archived side chats \(1\)/ }).click()
    await expect(list.getByTestId('thread-row').filter({ has: page.getByText('Coast road', { exact: true }) })).toBeVisible()
  })

  test('the chip opens the thread as a tab; Done puts it away, and Reopen brings it back', async ({ page }) => {
    await openConversation(page, 'Trip planning')
    await page.getByTestId('thread-news').click()
    await expect(page).toHaveURL(/\?thread=00000000-0000-4000-8000-00000000001a/)
    const tabs = page.getByRole('tablist')
    await expect(tabs.getByRole('tab', { name: /Wine cellars/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('thread-panel').getByText('Graham’s and Taylor’s.')).toBeVisible()
    await expect(page.getByTestId('thread-news')).toHaveCount(0)

    await page.getByRole('button', { name: 'Done with this side chat' }).click()
    await expect(tabs).toHaveCount(0)
    await page.locator('[data-testid="threads-pill"]:visible').click()
    const list = page.getByTestId('threads-popover')
    await expect(list.getByTestId('thread-row')).toHaveCount(0)
    await list.getByRole('button', { name: /Archived side chats \(2\)/ }).click()
    await list.getByRole('button', { name: 'Reopen Wine cellars' }).click()
    await expect(list.getByTestId('thread-row').filter({ has: page.getByText('Wine cellars', { exact: true }) })).toHaveCount(1)
  })

  test('a thread is renamed from its tab, and a blank one is started from the list', async ({ page }) => {
    await openConversation(page, 'Trip planning')
    await page.locator('[data-testid="threads-pill"]:visible').click()
    await page.getByTestId('threads-popover').getByTestId('thread-row').filter({ has: page.getByText('Wine cellars', { exact: true }) }).getByRole('button').first().click()
    const strip = page.getByRole('tablist')
    await strip.getByRole('tab', { name: /Wine cellars/ }).dblclick()
    const name = strip.getByRole('textbox', { name: 'Side chat name' })
    await name.fill('Port cellars')
    await name.press('Enter')
    await expect(page.getByRole('tablist').getByRole('tab', { name: /Port cellars/ })).toBeVisible()

    await page.locator('[data-testid="threads-pill"]:visible').click()
    await page.getByTestId('threads-popover').getByRole('button', { name: 'New side chat' }).click()
    const tabs = page.getByRole('tablist')
    await expect(tabs.getByRole('tab', { name: 'New side chat' })).toHaveAttribute('aria-selected', 'true')
    // The thread it replaced stays open as a tab.
    await expect(tabs.getByRole('tab', { name: /Port cellars/ })).toBeVisible()
    const box = page.getByTestId('thread-panel').getByPlaceholder('Write in the side chat…')
    await box.fill('Restaurants near Ribeira?')
    await box.press('Enter')
    await expect(page).toHaveURL(/\?thread=/)
    await expect(page.getByTestId('thread-panel').getByText('Restaurants near Ribeira?')).toBeVisible()
  })
})
