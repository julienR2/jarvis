import { test, expect, signIn, MISSING_CONVERSATION } from '../helpers'

/**
 * https://…/c/<id> is the address other apps open Jarvis on (a Paseo plugin
 * does, on every device). It has to work cold, signed out, and into an app
 * window that is already open.
 */
const MARKDOWN = '00000000-0000-4000-8000-000000000001'

test.describe('deep links', () => {
  test('a cold /c/<id> opens that conversation', async ({ page }) => {
    await signIn(page)
    // A fresh page on the link itself, no navigation inside the app first.
    const fresh = await page.context().newPage()
    await fresh.goto(`c/${MARKDOWN}`)
    await expect(fresh.getByRole('heading', { name: 'Headings, lists, code' })).toBeVisible()
    await expect(fresh).toHaveURL(new RegExp(`/c/${MARKDOWN}$`))
    await fresh.close()
  })

  test('signed out, the link survives the sign-in', async ({ page }) => {
    await page.goto(`c/${MARKDOWN}?run=x#end`)
    await expect(page).toHaveURL(/\/login\?next=/)
    await page.getByPlaceholder('Email').fill(process.env.E2E_EMAIL!)
    await page.getByPlaceholder('Password', { exact: true }).fill(process.env.E2E_PASSWORD!)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByRole('heading', { name: 'Headings, lists, code' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/c/${MARKDOWN}\\?run=x#end$`))
  })

  test('the login page will not send anyone off the site', async ({ page }) => {
    await page.goto('login?next=//example.com/')
    await page.getByPlaceholder('Email').fill(process.env.E2E_EMAIL!)
    await page.getByPlaceholder('Password', { exact: true }).fill(process.env.E2E_PASSWORD!)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByText('New chat')).toBeVisible()
    expect(new URL(page.url()).host).not.toBe('example.com')
  })

  test('an unknown id says so instead of loading forever', async ({ page }) => {
    await signIn(page)
    await page.goto(`c/${MISSING_CONVERSATION}`)
    await expect(page.getByTestId('chat-not-found')).toContainText('Conversation not found')
    await page.getByRole('button', { name: 'Back to Today' }).click()
    await expect(page).not.toHaveURL(/\/c\//)
  })

  test('a link handed to an open window switches chat in place', async ({ page }) => {
    // Chromium's launchQueue, stood in for: a real one only fires in an
    // installed app. What is under test is the consumer the app registers.
    await page.context().addInitScript(() => {
      // Defined, not assigned: Chromium has its own, read-only.
      let consumer: ((p: { targetURL: string }) => void) | null = null
      Object.defineProperty(window, 'launchQueue', {
        value: { setConsumer: (c: typeof consumer) => { consumer = c } },
      })
      Object.assign(window, { __launch: (url: string) => consumer?.({ targetURL: url }) })
    })
    await signIn(page)
    // Something only this document holds: a full reload would drop it.
    await page.evaluate(() => { (window as unknown as { __alive: boolean }).__alive = true })
    await page.evaluate((url) => (window as unknown as { __launch: (u: string) => void }).__launch(url),
      new URL(`c/${MARKDOWN}`, page.url()).href)
    await expect(page.getByRole('heading', { name: 'Headings, lists, code' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/c/${MARKDOWN}$`))
    expect(await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive)).toBe(true)
  })

  test('the manifest lets an installed app capture /c/ links', async ({ request }) => {
    const manifest = await (await request.get('api/manifest.webmanifest')).json()
    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      handle_links: 'preferred',
      launch_handler: { client_mode: ['focus-existing', 'auto'] },
    })
    expect(manifest.protocol_handlers).toBeUndefined()
  })
})
