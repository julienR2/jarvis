import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { test, expect, signIn, openConversation } from '../helpers'

/**
 * Tabs beside a chat: documents and links in the side pane, next to the app.
 * A file link in an answer opens as the temporary tab (italic, replaced by the
 * next one); the pin keeps it. Jarvis opens tabs through /internal, and a
 * document re-renders when its file changes.
 */
const RUN = dirname(process.env.E2E_CREDENTIALS || '')
const API = process.env.E2E_API || 'http://127.0.0.1:3105'
// Framed by the link test: a page that allows it and touches no storage.
const ENGINE_HEALTH = `http://127.0.0.1:${process.env.E2E_ENGINE_PORT || 3110}/health`
const SPEC_CHAT = '00000000-0000-4000-8000-000000000014'
const BRIEF_CHAT = '00000000-0000-4000-8000-000000000003'
const internalSecret = () => JSON.parse(readFileSync(join(RUN, 'secrets.json'), 'utf8')).internal as string

/** Back to the fixture: the spec chat holds its pinned spec.md and nothing else. */
async function resetTabs() {
  const headers = { 'X-Internal-Secret': internalSecret() }
  const { tabs } = await (await fetch(`${API}/internal/conversations/${SPEC_CHAT}/tabs`, { headers })).json() as { tabs: { id: string; title: string }[] }
  for (const tab of tabs) {
    if (tab.title !== 'spec.md') await fetch(`${API}/internal/conversations/${SPEC_CHAT}/tabs/${tab.id}`, { method: 'DELETE', headers })
  }
}

test.describe('tabs beside a chat', () => {
  // Several of these open the same chat's temporary tab: one at a time.
  test.describe.configure({ mode: 'serial' })
  test.beforeEach(async ({ page }) => {
    await resetTabs()
    await signIn(page)
  })

  test('a pinned document renders beside the chat; a file link opens as the temporary tab, the pin keeps it', async ({ page }) => {
    await openConversation(page, 'Spec draft')
    const pane = page.getByRole('tablist')
    await expect(pane.getByRole('tab', { name: /spec\.md/ })).toBeVisible()
    await expect(page.getByTestId('doc-view').getByRole('heading', { name: 'Side pane tabs — spec' })).toBeVisible()

    await page.getByRole('link', { name: 'report.md' }).click()
    const report = pane.getByRole('tab', { name: /report\.md/ })
    await expect(report).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('doc-view').getByRole('heading', { name: 'Weekly report' })).toBeVisible()
    await expect(report.locator('.italic')).toHaveCount(1)

    await report.hover()
    await page.getByRole('button', { name: 'Keep report.md' }).click()
    await expect(report.locator('.italic')).toHaveCount(0)

    await page.getByRole('button', { name: 'Close report.md' }).click()
    await expect(pane.getByRole('tab', { name: /report\.md/ })).toHaveCount(0)
    await expect(page.getByTestId('doc-view').getByRole('heading', { name: 'Side pane tabs — spec' })).toBeVisible()
  })

  test('the app keeps the first tab, documents sit beside it', async ({ page }) => {
    await openConversation(page, 'App with docs')
    const pane = page.getByRole('tablist')
    await expect(pane.getByRole('tab', { name: 'App' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.frameLocator('iframe[title="App preview"]').getByText('Docs app')).toBeVisible()
    await pane.getByRole('tab', { name: /spec\.md/ }).click()
    await expect(page.getByTestId('doc-view').getByRole('heading', { name: 'Side pane tabs — spec' })).toBeVisible()
    await pane.getByRole('tab', { name: 'App' }).click()
    await expect(page.frameLocator('iframe[title="App preview"]').getByText('Docs app')).toBeVisible()
  })

  test('Jarvis opens a document beside the chat, and it re-renders as the file changes', async ({ page }) => {
    await openConversation(page, 'Spec draft')
    const file = join(RUN, 'workspace', 'uploads', SPEC_CHAT, 'live.md')
    writeFileSync(file, '# Draft one\n')
    const res = await fetch(`${API}/internal/conversations/${SPEC_CHAT}/tabs`, {
      method: 'POST',
      headers: { 'X-Internal-Secret': internalSecret(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `/jarvis/agent/workspace/uploads/${SPEC_CHAT}/live.md`, title: 'Live draft' }),
    })
    expect(res.ok).toBe(true)
    await expect(page.getByRole('tab', { name: /Live draft/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('doc-view').getByRole('heading', { name: 'Draft one' })).toBeVisible()

    writeFileSync(file, '# Draft two\n')
    await expect(page.getByTestId('doc-view').getByRole('heading', { name: 'Draft two' })).toBeVisible({ timeout: 10_000 })
  })

  test('a link opens as a tab, with the way out always on screen', async ({ page }) => {
    await openConversation(page, 'Spec draft')
    const res = await fetch(`${API}/internal/conversations/${SPEC_CHAT}/tabs`, {
      method: 'POST',
      headers: { 'X-Internal-Secret': internalSecret(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: ENGINE_HEALTH }),
    })
    expect(res.ok).toBe(true)
    await expect(page.getByRole('tab', { name: /127\.0\.0\.1/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('link', { name: /Open in a new tab/ })).toHaveAttribute('href', ENGINE_HEALTH)
  })

  test('a document outside the workspace and the repo is refused', async () => {
    const res = await fetch(`${API}/internal/conversations/${SPEC_CHAT}/tabs`, {
      method: 'POST',
      headers: { 'X-Internal-Secret': internalSecret(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd' }),
    })
    expect(res.status).toBe(400)
  })

  test("a topic's document is a tab in each of its chats, listed on its page; a chat's tab can join it", async ({ page }) => {
    // Morning brief is in Daily, whose spec is pinned to the topic: the pane
    // waits behind the toggle (the chat has nothing of its own beside it).
    await openConversation(page, 'Morning brief')
    await page.getByRole('button', { name: 'Docs' }).first().click()
    const pane = page.getByRole('tablist')
    const shared = pane.getByRole('tab', { name: /Daily spec/ })
    await expect(shared).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: 'Close Daily spec' })).toHaveCount(0)
    await expect(page.getByTestId('doc-view').getByRole('heading', { name: 'Side pane tabs — spec' })).toBeVisible()

    // A document of the chat's own, shared with the topic, then taken back.
    const headers = { 'X-Internal-Secret': internalSecret(), 'Content-Type': 'application/json' }
    const res = await fetch(`${API}/internal/conversations/${BRIEF_CHAT}/tabs`, {
      method: 'POST', headers, body: JSON.stringify({ path: `/jarvis/agent/workspace/uploads/${SPEC_CHAT}/report.md` }),
    })
    expect(res.ok).toBe(true)
    await expect(pane.getByRole('tab', { name: /report\.md/ })).toHaveAttribute('aria-selected', 'true')
    await page.getByTitle('Pin to the topic — a tab in each of its chats').click()
    await expect(pane.getByRole('tab', { name: /report\.md/ })).toHaveAttribute('title', /Pinned to/)

    await page.goto(`t/${(await (await fetch(`${API}/internal/conversations/${BRIEF_CHAT}`, { headers })).json()).topic.id}`)
    const docs = page.getByTestId('topic-docs')
    await expect(docs.getByTestId('topic-doc')).toHaveCount(2)
    await docs.getByRole('button', { name: 'Remove report.md from the topic' }).click()
    await expect(docs.getByTestId('topic-doc')).toHaveCount(1)
  })

  test('an app talks to its chat through window.jarvis: send, ask, run, context', async ({ page }) => {
    await openConversation(page, 'Bridge app')
    const app = page.frameLocator('iframe[title="App preview"]')
    await expect(app.getByText('bridge: on')).toBeVisible()

    await app.getByRole('button', { name: 'Ask' }).click()
    await expect(app.getByText('answer: Answer from the stub engine')).toBeVisible()
    await app.getByRole('button', { name: 'Context' }).click()
    await expect(app.getByText('chat: ◫ Bridge app')).toBeVisible()
    await app.getByRole('button', { name: 'Run', exact: true }).click()
    await expect(app.getByText('ran', { exact: true })).toBeVisible()
    // Only the routines reporting into this chat.
    await app.getByRole('button', { name: 'Run other' }).click()
    await expect(app.getByText(/refused: No enabled webhook "fixture-hook"/)).toBeVisible()
    await app.getByRole('button', { name: 'Send' }).click()
    await expect(app.getByText('sent')).toBeVisible()
    await expect(page.locator('[data-message-id]').filter({ hasText: 'Hello from the bridge app' })).toBeVisible()
  })

  test('jarvis.prefill stages a message: the quote above the composer, text in it, the chat brought back — nothing sent', async ({ page }) => {
    await openConversation(page, 'Bridge app')
    const main = page.getByRole('main')
    const composer = page.getByPlaceholder('How can I help you today?')
    // The app alone, the chat put away…
    await main.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(composer).toBeHidden()
    const app = page.frameLocator('iframe[title="App preview"]')
    await app.getByRole('button', { name: 'Prefill' }).click()
    await expect(app.getByText('prefilled')).toBeVisible()
    // …comes back, holding the app's quote and text, the cursor in it.
    await expect(page.getByTestId('composer-quote')).toContainText('Invoice 42 from the bridge app')
    await expect(composer).toBeVisible()
    await expect(composer).toHaveValue('Can we pay it')
    await expect(composer).toBeFocused()
    await expect(page.locator('[data-message-id]').filter({ hasText: 'Can we pay it' })).toHaveCount(0)
    // Sent, the bubble carries the quote — nothing in the chat to jump to.
    await composer.pressSequentially('?')
    await composer.press('Enter')
    const sent = page.locator('[data-message-id]').filter({ hasText: 'Can we pay it?' })
    await expect(sent).toBeVisible()
    await expect(sent.getByTestId('reply-citation')).toContainText('Invoice 42 from the bridge app')
    await expect(page.getByTestId('composer-quote')).toHaveCount(0)
  })

  test('jarvis.prefill on a phone switches from the app to the chat, focused', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('c/00000000-0000-4000-8000-000000000016')
    const composer = page.getByPlaceholder('How can I help you today?')
    const frame = page.locator('iframe[title="App preview"]')
    await expect(frame).toBeVisible()
    await expect(composer).toBeHidden()
    await page.frameLocator('iframe[title="App preview"]').getByRole('button', { name: 'Prefill' }).click()
    await expect(composer).toBeVisible()
    await expect(frame).toBeHidden()
    await expect(composer).toBeFocused()
    await expect(page.getByTestId('composer-quote')).toContainText('Invoice 42 from the bridge app')
  })

  test('opened on its own, as a share link is, an app has no bridge', async ({ page }) => {
    await page.goto(`${API}/api/apps/fixture-bridge/index.html?token=${process.env.E2E_TOKEN}`)
    await expect(page.getByText('bridge: off')).toBeVisible()
  })
})
