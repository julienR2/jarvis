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
})
