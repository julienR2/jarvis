import { test, expect, signIn } from '../helpers'

/**
 * The share screen (/share, where the PWA share target lands): what Settings
 * pinned first, then the sidebar's tree. Fixtures: the ☀️ Daily topic, the
 * fixture-hook webhook.
 */
test.describe('share sheet', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('a webhook pinned in Settings comes first, and runs on what was shared', async ({ page }) => {
    await page.goto('settings')
    await page.getByRole('button', { name: 'Pin a chat, topic or webhook' }).click()
    await page.getByTestId('share-pin-tree').getByRole('button', { name: 'Pin fixture-hook' }).click()
    const pins = page.getByTestId('share-pins')
    await expect(pins.getByText('fixture-hook', { exact: true })).toBeVisible()
    // Survives a reload: pins live in the database, not on the device.
    await page.reload()
    await expect(page.getByTestId('share-pins').getByText('fixture-hook', { exact: true })).toBeVisible()

    await page.goto('share?text=' + encodeURIComponent('shared from e2e'))
    const pinned = page.getByTestId('share-pinned')
    await expect(pinned.getByRole('button', { name: 'fixture-hook' })).toBeVisible()
    await pinned.getByRole('button', { name: 'fixture-hook' }).click()
    // Opens the webhook's thread, the shared text as the run's message.
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
    await expect(page.getByText('shared from e2e').first()).toBeVisible()

    // Put things back for the other specs.
    await page.goto('settings')
    await page.getByTestId('share-pins').getByRole('button', { name: 'Unpin' }).click()
    await expect(page.getByText('Nothing pinned.')).toBeVisible()
  })

  test('a topic’s + starts a new chat in it, with the shared text in the composer', async ({ page }) => {
    await page.goto('share?text=' + encodeURIComponent('into the topic'))
    await page.getByRole('button', { name: 'New chat in ☀️ Daily' }).click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('textbox').first()).toHaveValue(/into the topic/)
    // Filed under the topic, not just opened.
    const id = page.url().split('/c/')[1]
    const headers = { Authorization: `Bearer ${process.env.E2E_TOKEN}` }
    const conv = await (await page.request.get(`api/conversations/${id}`, { headers })).json()
    const sections = await (await page.request.get('api/sections', { headers })).json()
    expect(conv.section_id).toBe(sections.find((s: { name: string }) => s.name === '☀️ Daily').id)
  })

  test('a shared file reaches the webhook run as an attachment of its message', async ({ page }) => {
    const headers = { Authorization: `Bearer ${process.env.E2E_TOKEN}` }
    const hooks = await (await page.request.get('api/webhooks', { headers })).json()
    const hook = hooks.find((h: { name: string }) => h.name === 'fixture-hook')
    const { thread_id } = await (await page.request.post(`api/webhooks/${hook.id}/thread`, { headers })).json()
    const upload = await page.request.post(`api/uploads?conversationId=${thread_id}`, {
      headers,
      multipart: { file: { name: 'memo.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('not really audio') } },
    })
    const attachment = await upload.json()
    expect(attachment.filename.startsWith(`${thread_id}/`)).toBe(true)
    const shared = await page.request.post(`api/webhooks/${hook.id}/share`, { headers, data: { attachments: [attachment] } })
    expect((await shared.json()).thread_id).toBe(thread_id)
    await expect.poll(async () => {
      const conv = await (await page.request.get(`api/conversations/${thread_id}`, { headers })).json()
      return conv.messages.some((m: { role: string; metadata: string | null }) =>
        m.role === 'user' && (m.metadata ?? '').includes('memo.m4a'))
    }).toBe(true)
  })
})
