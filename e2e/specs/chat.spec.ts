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

  test('activity: steps stay folded until asked, result reads as prose', async ({ page }) => {
    await openConversation(page, 'Activity steps')
    await expect(page.getByText('10 photos')).toBeVisible()
    const steps = page.getByRole('button', { name: /^2 steps$/ })
    await expect(steps).toBeVisible()
    await expect(page.getByText('ls /workspace/gallery/2026-09')).toBeHidden()
    await steps.click()
    await expect(page.getByText('ls /workspace/gallery/2026-09')).toBeVisible()
  })

  test('background run: the marker names the cron and its isolation', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    await expect(page.getByText('Cron: morning-brief')).toBeVisible()
    await expect(page.getByText("outside this chat's memory")).toBeVisible()
    await expect(page.getByText('Court booking opens')).toBeVisible()
  })

  test('app pane: the fixture app renders beside the chat', async ({ page }) => {
    await openConversation(page, 'Fixture app')
    const frame = page.frameLocator('iframe[title="App preview"]')
    await expect(frame.getByTestId('fixture-app')).toBeVisible()
  })
})
