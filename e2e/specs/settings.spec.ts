import { test, expect, signIn } from '../helpers'

test.describe('settings', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('the sidebar gear is a menu of places, opened above it and inside the window', async ({ page }) => {
    const gear = page.getByRole('button', { name: 'Settings', exact: true })
    await gear.click()
    const menu = page.getByRole('menu')
    for (const item of ['General', 'Routines', 'Capabilities', 'Browser', 'Archive']) {
      await expect(menu.getByRole('menuitem', { name: new RegExp(`^${item}`) })).toBeVisible()
    }
    // Opened from the bottom edge: it goes up, and every pixel is on screen.
    const [m, g, vp] = [await menu.boundingBox(), await gear.boundingBox(), page.viewportSize()]
    expect(m && g && vp).toBeTruthy()
    expect(m!.y + m!.height).toBeLessThanOrEqual(g!.y)
    expect(m!.y).toBeGreaterThanOrEqual(0)
    expect(m!.x + m!.width).toBeLessThanOrEqual(vp!.width)
    await menu.getByRole('menuitem', { name: /^Capabilities/ }).click()
    await expect(page).toHaveURL(/\/settings\/customize$/)
    await expect(page.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true')
  })

  test('general: appearance, API keys and the account on one page', async ({ page }) => {
    await page.goto('settings')
    await expect(page.getByText('Appearance & behaviour')).toBeVisible()
    await expect(page.getByText('API keys')).toBeVisible()
    await expect(page.getByText('Signed in on this device')).toBeVisible()
    await expect(page.getByRole('tab')).toHaveCount(0)
  })

  test('theme picks apply to the document and persist', async ({ page }) => {
    await page.goto('settings')
    await page.getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.reload()
    await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('radio', { name: 'System' }).click()
  })

  test('api keys: create shows the secret once, then lists the key', async ({ page }) => {
    await page.goto('settings')
    await expect(page.getByText('fixture key')).toBeVisible()
    await page.getByPlaceholder(/what is it for/).fill('e2e key')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('button', { name: /^Copy$/ }).first()).toBeVisible()
    await expect(page.getByText('e2e key').first()).toBeVisible()
  })

  test('customize › models: the two provider cards', async ({ page }) => {
    await page.goto('settings/customize')
    await expect(page.getByText('Claude subscription')).toBeVisible()
    await expect(page.getByText('OpenRouter', { exact: true })).toBeVisible()
    // One gateway, one URL: no Custom chip, no URL field to fill.
    await expect(page.getByRole('button', { name: 'Custom' })).toHaveCount(0)
    await expect(page.getByPlaceholder('https://…')).toHaveCount(0)
  })

  test('customize › one, without a key', async ({ page }) => {
    await page.goto('settings/customize?tab=connectors')
    // No key yet: the Connectors tab offers to paste one in place.
    await expect(page.getByText('Have a One key?')).toBeVisible()
    await page.getByRole('tab', { name: 'One' }).click()
    await expect(page).toHaveURL(/tab=one$/)
    await expect(page.getByPlaceholder('sk_live_…')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('customize › connectors and skills', async ({ page }) => {
    await page.goto('settings/customize?tab=connectors')
    await expect(page.getByText('Add connector')).toBeVisible()
    await page.getByRole('tab', { name: 'Skills' }).click()
    await expect(page).toHaveURL(/tab=skills$/)
    const skill = page.getByTestId('skill-row').filter({ hasText: /^connectors/ })
    await expect(skill).toBeVisible()
    await skill.getByRole('button', { name: 'Open' }).click()
    const dialog = page.getByRole('dialog', { name: 'connectors' })
    await expect(dialog).toBeVisible()
    // Edit shows the raw file, front matter included; Cancel leaves it untouched.
    await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: 'SKILL.md' })).toHaveValue(/^---\nname: connectors/)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // Edit in chat: Today, with the request started in the composer.
    await skill.getByRole('button', { name: 'Edit in chat' }).click()
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/)
    const composer = page.getByPlaceholder('How can I help you today?')
    await expect(composer).toHaveValue('I want to edit the "connectors" skill: ')
    await expect(composer).toBeFocused()
  })

  test('customize › a connector can hide its values from Jarvis', async ({ page }) => {
    const name = `Hidden API ${Date.now()}`
    await page.goto('settings/customize?tab=connectors')
    await page.getByRole('button', { name: /Add connector/ }).click()
    await page.getByPlaceholder('e.g. Notion, Gmail (papa)').fill(name)
    await page.getByPlaceholder('Label').first().fill('API key')
    await page.getByPlaceholder('Value').first().fill('sk-test')
    await page.getByRole('button', { name: 'Add field' }).click()
    await page.getByPlaceholder('Label').nth(1).fill('Base URL')
    await page.getByPlaceholder('Value').nth(1).fill('https://api.example.com')
    await page.getByRole('button', { name: 'Field type' }).nth(1).click()
    await page.getByRole('option', { name: 'Text' }).click()

    // Hiding needs a proxy: saving without one says what is missing.
    await page.getByRole('radio', { name: /Hide secret values/ }).check()
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText('Pick the field that holds the service URL')).toBeVisible()

    await page.getByRole('button', { name: 'URL field' }).click()
    await page.getByRole('option', { name: 'Base URL' }).click()
    await page.getByRole('button', { name: 'Credential field' }).click()
    await page.getByRole('option', { name: 'API key' }).click()
    await page.getByRole('button', { name: 'Create' }).click()

    // The innermost element holding both the name and its Edit button: the card.
    const card = page.locator('div')
      .filter({ has: page.getByText(name, { exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Edit' }) })
      .last()
    await expect(card.getByText('Hidden from Jarvis')).toBeVisible()
    // Reopened, it remembers both the choice and the proxy settings.
    await card.getByRole('button', { name: 'Edit' }).click()
    await expect(page.getByRole('radio', { name: /Hide secret values/ })).toBeChecked()
    await expect(page.getByRole('button', { name: 'URL field' })).toContainText('Base URL')
    await expect(page.getByRole('button', { name: 'Credential field' })).toContainText('API key')
  })

  test('old addresses land where their content went', async ({ page }) => {
    await page.goto('connectors')
    await expect(page).toHaveURL(/\/settings\/customize\?tab=connectors$/)
    await page.goto('settings?tab=models')
    await expect(page).toHaveURL(/\/settings\/customize\?tab=models$/)
    await page.goto('api-keys')
    await expect(page).toHaveURL(/\/settings$/)
    await page.goto('plugins')
    await expect(page).toHaveURL(/\/settings$/)
    await page.goto('connection')
    await expect(page).toHaveURL(/\/settings\/customize$/)
  })
})
