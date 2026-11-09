import { test, expect, signIn } from '../helpers'

const chat = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

// One list for the whole instance: these must not interleave.
test.describe.configure({ mode: 'serial' })

test.describe('home screen shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('added from the chat menu, listed in settings and the manifest, removed from settings', async ({ page, playwright }) => {
    await page.goto(`c/${chat(1)}`)
    await page.getByRole('main').getByTitle('Conversation options').locator('visible=true').first().click()
    await page.getByRole('button', { name: 'Add to shortcuts' }).click()
    await expect(page.getByText(/Long-press the Jarvis icon/)).toBeVisible()

    const manifest = async () => (await (await page.request.get('api/manifest.webmanifest')).json()) as { shortcuts?: { url: string }[] }
    await expect.poll(async () => (await manifest()).shortcuts?.map((s) => s.url)).toEqual([`/c/${chat(1)}`])

    // Titles are private: a browser without the session gets none.
    const anonymous = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL })
    const bare = await (await anonymous.get('api/manifest.webmanifest')).json()
    expect(bare.shortcuts).toBeUndefined()
    await anonymous.dispose()

    await page.goto('settings')
    const remove = page.getByRole('button', { name: /^Remove .* from shortcuts$/ })
    await expect(remove).toHaveCount(1)
    await remove.click()
    await expect(page.getByText('No shortcuts yet.')).toBeVisible()
    await expect.poll(async () => (await manifest()).shortcuts).toBeUndefined()
  })

  test('a fifth is refused while four are listed', async ({ page }) => {
    const auth = { Authorization: `Bearer ${process.env.E2E_TOKEN}` }
    for (const n of [1, 2, 3, 4]) {
      const res = await page.request.patch(`api/conversations/${chat(n)}`, { headers: auth, data: { shortcut: true } })
      expect(res.ok()).toBe(true)
    }
    try {
      await page.goto(`c/${chat(5)}`)
      await page.getByRole('main').getByTitle('Conversation options').locator('visible=true').first().click()
      await page.getByRole('button', { name: 'Add to shortcuts' }).click()
      await expect(page.getByText(/Already 4 shortcuts/)).toBeVisible()
      await page.goto('settings')
      await expect(page.getByRole('button', { name: /^Remove .* from shortcuts$/ })).toHaveCount(4)
    } finally {
      for (const n of [1, 2, 3, 4]) {
        await page.request.patch(`api/conversations/${chat(n)}`, { headers: auth, data: { shortcut: false } })
      }
    }
  })
})
