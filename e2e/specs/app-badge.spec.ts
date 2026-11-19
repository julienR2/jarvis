import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { test, expect, signIn, openConversation } from '../helpers'

/**
 * A chat's badge, set by its app: `jarvis.setBadge(n)` from the app, or the
 * internal API from a routine while the app is closed. It shows on the chat's
 * row in place of the unread count, and stays while you are in the chat.
 */
const RUN = dirname(process.env.E2E_CREDENTIALS || '')
const API = process.env.E2E_API || 'http://127.0.0.1:3105'
const SECOND_APP = '00000000-0000-4000-8000-000000000008'
const internalSecret = () => JSON.parse(readFileSync(join(RUN, 'secrets.json'), 'utf8')).internal as string

async function setBadge(count: number | null) {
  const res = await fetch(`${API}/internal/apps/${SECOND_APP}/badge`, {
    method: 'PUT',
    headers: { 'X-Internal-Secret': internalSecret(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  })
  expect(res.ok).toBe(true)
}

const rowOf = (page: import('@playwright/test').Page, title: string) =>
  page.getByRole('complementary').getByText(title, { exact: true }).locator('xpath=..')

test.describe('a chat badge set by its app', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('from a routine, through the internal API: shown on the row, then cleared', async ({ page }) => {
    const row = rowOf(page, '◫ Second app')
    await expect(row.getByTestId('chat-badge')).toHaveCount(0)
    try {
      await setBadge(6)
      await expect(row.getByTestId('chat-badge')).toHaveText('6')
    } finally {
      await setBadge(null)
    }
    await expect(row.getByTestId('chat-badge')).toHaveCount(0)
  })

  test('from the app, through jarvis.setBadge — and it stays while the chat is open', async ({ page }) => {
    await openConversation(page, 'Bridge app')
    const row = rowOf(page, '◫ Bridge app')
    const app = page.frameLocator('iframe[title="App preview"]')
    await app.getByRole('button', { name: 'Badge', exact: true }).click()
    await expect(app.getByText('badged', { exact: true })).toBeVisible()
    await expect(row.getByTestId('chat-badge')).toHaveText('6')
    await app.getByRole('button', { name: 'Unbadge' }).click()
    await expect(app.getByText('unbadged')).toBeVisible()
    await expect(row.getByTestId('chat-badge')).toHaveCount(0)
  })
})
