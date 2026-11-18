import { test, expect, signIn } from '../helpers'

/**
 * Routines run in conversations of their own. Fixtures: surf-watch runs under
 * "🏄 Surf" — three runs with nothing to say, then one with news, unread;
 * price-watch hangs under nothing and had news; backup-check hangs under
 * nothing and only ever said nothing.
 */
const SURF = '00000000-0000-4000-8000-00000000000f'
const SURF_THREAD = '00000000-0000-4000-8000-000000000010'
const PRICE_THREAD = '00000000-0000-4000-8000-000000000011'

test.describe('threads', () => {
  // In order: the first reads the badges before anything opens the routine.
  test.describe.configure({ mode: 'serial' })
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('a routine’s news stays in its own conversation, shown under its chat with its mark', async ({ page }) => {
    await page.goto('')
    const sidebar = page.locator('aside')
    // The chat itself has nothing new: nothing was written into it.
    const surf = sidebar.getByText('🏄 Surf', { exact: true }).locator('..')
    await expect(surf.getByText('1', { exact: true })).toHaveCount(0)
    // Its routine has, and shows under it — a schedule's mark beside it.
    const routine = sidebar.getByText('surf-watch', { exact: true }).locator('..')
    await expect(routine.getByText('1', { exact: true })).toBeVisible()
    await expect(routine.getByTestId('routine-mark')).toHaveAttribute('title', 'Runs on a schedule')

    await page.goto(`c/${SURF}`)
    await expect(page.getByText('Go now.')).toHaveCount(0)
    // The # list has it, one list with the chat's side chats.
    await page.locator('[data-testid="threads-pill"]:visible').click()
    const popover = page.getByTestId('threads-popover')
    const row = popover.getByTestId('thread-row').filter({ hasText: 'surf-watch' })
    await expect(row.getByText('1', { exact: true })).toBeVisible()
    await row.getByRole('button', { name: /^surf-watch/ }).click()
    await expect(page.getByText('Go now.')).toBeVisible()
  })

  test('a routine under no chat is a chat like any other; one that never had news is too, without a badge', async ({ page }) => {
    await page.goto('')
    const sidebar = page.locator('aside')
    const price = sidebar.getByText('price-watch', { exact: true }).locator('..')
    // (Its badge is not checked: the Routines page spec may have read it already.)
    await expect(price).toBeVisible()
    const backup = sidebar.getByText('backup-check', { exact: true }).locator('..')
    await expect(backup).toBeVisible()
    await expect(backup.getByTestId('routine-mark')).toBeVisible()
    // No Routines group any more: the page is in the Settings menu.
    await expect(page.getByTestId('threads-group')).toHaveCount(0)
  })

  test('a routine’s runs open under it on the Routines page, each into its conversation', async ({ page }) => {
    await page.goto('routines')
    const row = page.getByTestId('routine-row').filter({ hasText: 'price-watch' })
    await expect(row.getByText('its own chat')).toBeVisible()
    await row.getByRole('button', { name: /last ran/ }).click()
    const runs = row.getByTestId('routine-runs').getByRole('button')
    await expect(runs).toHaveCount(2)
    await runs.first().click()
    await expect(page).toHaveURL(new RegExp(`/c/${PRICE_THREAD}\\?run=`))
    await expect(page.getByText('Dropped to')).toBeVisible()
  })

  test('a thread can be hung under another conversation, and not under itself', async ({ page }) => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.E2E_TOKEN}` }
    const patch = (id: string, body: object) => page.request.patch(`api/conversations/${id}`, { headers, data: body })
    // Under its own thread: a loop, refused.
    expect((await patch(SURF, { parent_id: SURF_THREAD })).status()).toBe(400)
    // Under price-watch, and back: the routine follows.
    expect((await patch(SURF_THREAD, { parent_id: PRICE_THREAD })).ok()).toBe(true)
    const hooks = await (await page.request.get('api/crons', { headers })).json() as { name: string; conversation_id: string | null }[]
    expect(hooks.find((c) => c.name === 'surf-watch')?.conversation_id).toBe(PRICE_THREAD)
    expect((await patch(SURF_THREAD, { parent_id: SURF })).ok()).toBe(true)
  })
})

test.describe('a webhook with a thread per call', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('each call opens a thread under its chat; a call with a key already seen goes back to it', async ({ page }) => {
    const headers = { Authorization: `Bearer ${process.env.E2E_TOKEN}`, 'Content-Type': 'application/json' }
    const chat = await (await page.request.post('api/conversations', { headers, data: { title: 'Per-call home' } })).json() as { id: string }
    const hook = await (await page.request.post('api/webhooks', {
      headers, data: { name: 'e2e-per-call', prompt: 'Handle it.', conversation_id: chat.id, thread_per_fire: true },
    })).json() as { id: string; token: string; thread_id: string }
    const fire = (data: object) => page.request.post(`api/hooks/${hook.token}/trigger`, { headers: { 'Content-Type': 'application/json' }, data })
    const threads = async () => ((await (await page.request.get('api/conversations', { headers })).json()) as { id: string; parent_id: string | null }[])
      .filter((c) => c.parent_id === chat.id && c.id !== hook.thread_id)

    expect((await fire({ thread_key: 'mail-a', body: 'first' })).ok()).toBe(true)
    await expect.poll(async () => (await threads()).length).toBe(1)
    expect((await fire({ thread_key: 'mail-b', body: 'other' })).ok()).toBe(true)
    await expect.poll(async () => (await threads()).length).toBe(2)
    // The same key: back into its thread, no new one.
    expect((await fire({ thread_key: 'mail-a', body: 'reply' })).ok()).toBe(true)
    await expect.poll(async () => {
      const runs = await (await page.request.get(`api/runs?source_id=${hook.id}`, { headers })).json() as { conversation_id: string }[]
      return runs.length
    }).toBe(3)
    expect((await threads()).length).toBe(2)
    const runs = await (await page.request.get(`api/runs?source_id=${hook.id}`, { headers })).json() as { conversation_id: string }[]
    expect(new Set(runs.map((r) => r.conversation_id)).size).toBe(2)

    // Leave the instance as found — archived, not deleted: another test's
    // Today may be reading these threads' messages right now.
    await page.request.patch(`api/conversations/${chat.id}`, { headers, data: { archived: true } })
    await page.request.delete(`api/webhooks/${hook.id}`, { headers: { Authorization: headers.Authorization } })
  })
})
