import { test, expect, signIn } from '../helpers'

test.describe('settings pages', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('crons: the seeded cron is listed, disabled, and can be toggled', async ({ page }) => {
    await page.goto('crons')
    await expect(page.getByText('morning-brief').first()).toBeVisible()
    // exact: the sidebar has an "Enable notifications" button that a substring
    // match would pick up first.
    const enable = page.getByTitle('Enable', { exact: true })
    await expect(enable).toBeVisible()
    await enable.click()
    const disable = page.getByTitle('Disable', { exact: true })
    await expect(disable).toBeVisible()
    // Leave it as we found it — a live cron on a throwaway instance still costs.
    await disable.click()
    await expect(page.getByTitle('Enable', { exact: true })).toBeVisible()
  })

  test('webhooks: the seeded hook is listed with its trigger URL', async ({ page }) => {
    await page.goto('webhooks')
    await expect(page.getByText('fixture-hook').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copy URL' }).first()).toBeVisible()
  })

  test('connectors: the page renders its sections', async ({ page }) => {
    await page.goto('connectors')
    await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible()
    await expect(page.getByText('Add connector')).toBeVisible()
  })

  test('api keys: create shows the secret once, then lists the key', async ({ page }) => {
    await page.goto('api-keys')
    await expect(page.getByText('fixture key')).toBeVisible()
    await page.getByPlaceholder(/What is it for/).fill('e2e key')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('button', { name: /^Copy$/ })).toBeVisible()
    await expect(page.getByText('e2e key').first()).toBeVisible()
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
