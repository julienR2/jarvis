import { test, expect, signIn } from '../helpers'

test.describe('settings', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('one sidebar entry opens the overview; cards switch tabs', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Appearance & behaviour')).toBeVisible()
    await page.getByRole('button', { name: /^Connectors/ }).click()
    await expect(page).toHaveURL(/\/settings\?tab=connectors$/)
    await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible()
    await expect(page.getByText('Add connector')).toBeVisible()
  })

  test('theme picks apply to the document and persist', async ({ page }) => {
    await page.goto('settings')
    await page.getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.reload()
    await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('radio', { name: 'System' }).click()
  })

  test('models: the two provider cards', async ({ page }) => {
    await page.goto('settings?tab=models')
    await expect(page.getByText('Claude subscription')).toBeVisible()
    await expect(page.getByText('OpenRouter', { exact: true })).toBeVisible()
    // One gateway, one URL: no Custom chip, no URL field to fill.
    await expect(page.getByRole('button', { name: 'Custom' })).toHaveCount(0)
    await expect(page.getByPlaceholder('https://…')).toHaveCount(0)
  })

  test('access: create shows the secret once, then lists the key', async ({ page }) => {
    await page.goto('settings?tab=access')
    await expect(page.getByText('fixture key')).toBeVisible()
    await page.getByPlaceholder(/What is it for/).fill('e2e key')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('button', { name: /^Copy$/ }).first()).toBeVisible()
    await expect(page.getByText('e2e key').first()).toBeVisible()
  })

  test('advanced: plugins inline, code and browser as tools', async ({ page }) => {
    await page.goto('settings?tab=advanced')
    await expect(page.getByRole('heading', { name: 'Marketplaces' })).toBeVisible()
    await page.getByRole('button', { name: /^Code/ }).click()
    await expect(page).toHaveURL(/\/code$/)
  })

  test('old addresses land on their tab', async ({ page }) => {
    await page.goto('connectors')
    await expect(page).toHaveURL(/\/settings\?tab=connectors$/)
    await page.goto('api-keys')
    await expect(page).toHaveURL(/\/settings\?tab=access$/)
    await page.goto('plugins')
    await expect(page).toHaveURL(/\/settings\?tab=advanced$/)
    await page.goto('connection')
    await expect(page).toHaveURL(/\/settings\?tab=models$/)
  })

  test('code: the repository browser opens with its tabs', async ({ page }) => {
    await page.goto('code')
    for (const tab of ['Config', 'Source', 'Commits']) {
      await expect(page.getByText(tab, { exact: true }).first()).toBeVisible()
    }
    await page.getByText('Commits', { exact: true }).first().click()
    // The newest commit of this very repo is on screen — some hash, some message.
    await expect(page.getByText(/[0-9a-f]{7}/).first()).toBeVisible()
  })
})
