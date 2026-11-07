import { test, expect, signIn, openConversation } from '../helpers'
import type { Page } from '@playwright/test'

/**
 * The composer keeps a draft per chat (lib/drafts): what is typed, attached or
 * being transcribed stays with the chat it was meant for. Each test makes its
 * own chats, so nothing it sends shows up in the fixtures.
 */
const headers = () => ({ Authorization: `Bearer ${process.env.E2E_TOKEN}` })

async function newChat(page: Page, title: string): Promise<string> {
  const res = await page.request.post('api/conversations', { headers: headers(), data: { title } })
  return (await res.json()).id
}

const composer = (page: Page) => page.getByPlaceholder('How can I help you today?')

test.describe('composer drafts', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('typed text stays with its chat: blank elsewhere, back on return, a pencil in the sidebar meanwhile', async ({ page }) => {
    const a = `Draft A ${Date.now()}`
    const b = `Draft B ${Date.now()}`
    await newChat(page, a)
    await newChat(page, b)
    await page.reload()

    await openConversation(page, a)
    await composer(page).fill('half a thought')
    await openConversation(page, b)
    await expect(composer(page)).toHaveValue('')
    const rowA = page.getByText(a).first().locator('xpath=ancestor::div[contains(@class,"group")][1]')
    await expect(rowA.getByTestId('draft-marker')).toBeVisible()

    await openConversation(page, a)
    await expect(composer(page)).toHaveValue('half a thought')
    // And across a reload: drafts live in localStorage.
    await page.reload()
    await expect(composer(page)).toHaveValue('half a thought')
    await composer(page).fill('')
  })

  test('a voice message takes the attached file along', async ({ page }) => {
    const id = await newChat(page, `Voice with file ${Date.now()}`)
    await page.goto(`c/${id}`)
    await page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(page.locator('[title="notes.txt"]')).toBeVisible()
    await page.getByTitle('Tap to record').click()
    await page.waitForTimeout(500)
    await page.getByTitle('Send voice message').click()

    await expect(page.getByText('Voice note from the e2e microphone')).toBeVisible({ timeout: 5_000 })
    const conv = await (await page.request.get(`api/conversations/${id}`, { headers: headers() })).json()
    const mine = conv.messages.find((m: { role: string }) => m.role === 'user')
    expect(mine.metadata ?? '').toContain('notes.txt')
    // The composer gave it up.
    await expect(page.locator('[title="notes.txt"]')).toHaveCount(0)
  })

  test('"Transcribe to text" finishes into the chat it was recorded in, not the one on screen', async ({ page }) => {
    const a = `Dictate A ${Date.now()}`
    const b = `Dictate B ${Date.now()}`
    await newChat(page, a)
    await newChat(page, b)
    await page.reload()

    await openConversation(page, a)
    await page.getByTitle('Tap to record').click()
    await page.waitForTimeout(500)
    await page.getByTitle('Transcribe to text').click()
    await expect(page.getByText('Transcribing…')).toBeVisible()

    // Leave while the stub's Whisper is still at it (1.5 s).
    await openConversation(page, b)
    await expect(page.getByText('Transcribing…')).toHaveCount(0)
    await page.waitForTimeout(2_000)
    await expect(composer(page)).toHaveValue('')

    await openConversation(page, a)
    await expect(composer(page)).toHaveValue('Voice note from the e2e microphone')
    await composer(page).fill('')
  })
})

test.describe('sharing into a chat with an app', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('an app that does not take shares leaves them to its chat’s composer', async ({ page }) => {
    await page.goto('share?text=' + encodeURIComponent('for the app chat'))
    await page.getByRole('button', { name: 'Expand 🏗️ Projects' }).click()
    await page.getByRole('button', { name: /Fixture app/ }).first().click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
    await expect(composer(page)).toHaveValue(/for the app chat/)
    await expect(composer(page)).toBeVisible()
    await composer(page).fill('')
  })
})
