import { test, expect, signIn } from '../helpers'

test.describe('access', () => {
  test('wrong password is refused with a visible error', async ({ page }) => {
    await page.goto('login')
    await page.getByPlaceholder('Email').fill(process.env.E2E_EMAIL!)
    await page.getByPlaceholder('Password', { exact: true }).fill('definitely-not-it')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.locator('.text-danger')).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
  })

  test('the real password signs in and lands in the app', async ({ page }) => {
    await page.goto('login')
    await page.getByPlaceholder('Email').fill(process.env.E2E_EMAIL!)
    await page.getByPlaceholder('Password', { exact: true }).fill(process.env.E2E_PASSWORD!)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByText('New chat')).toBeVisible()
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('onboarding renders and can be skipped', async ({ page }) => {
    await signIn(page)
    await page.goto('onboarding')
    await expect(page.getByText('Welcome to Jarvis')).toBeVisible()
    await expect(page.getByRole('button', { name: /get started/i })).toBeVisible()
    await page.getByTitle('Skip onboarding').click()
    await expect(page.getByText('New chat')).toBeVisible()
  })
})
