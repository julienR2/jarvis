import { test, expect, signIn } from '../helpers'

/** Home, with or without its trailing slash. */
const HOME = /^https?:\/\/[^/]+\/?$/

/**
 * A topic as a page. Fixtures: the "🏗️ Projects" section carries a brief (the
 * edit test rewrites it), "🧪 Fixtures" a long one (the fold test), and
 * holds the fixture app, the blog publish chat (with its webhook) and the trip
 * idea chat (waiting on an answer); "☀️ Daily" has no brief.
 */
test.describe('topic', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('the topic name in the sidebar opens its page: brief, what waits, routines, chats', async ({ page }) => {
    await page.getByTitle('Open the topic').filter({ hasText: 'Projects' }).click()
    await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/)
    const brief = page.getByTestId('topic-brief')
    await expect(brief.getByRole('heading', { name: /Brief/ })).toBeVisible()
    await expect(brief.getByText('side projects and the tooling around them')).toBeVisible()
    await expect(brief.getByText('publish-post', { exact: false }).first()).toBeVisible()
    // What waits on you here — the trip question — and only that.
    const waiting = page.getByTestId('topic-waiting')
    await expect(waiting.getByTestId('today-row').filter({ hasText: 'Trip idea' })).toHaveCount(1)
    await expect(waiting.getByText('Reply to Marta')).toBeHidden()
    // The routines posting into this topic's chats.
    await expect(page.getByTestId('topic-routines').getByTestId('topic-routine').filter({ hasText: 'publish-post' })).toHaveCount(1)
    await expect(page.getByTestId('topic-routines').getByText('morning-brief')).toBeHidden()
    // Its chats, and only its chats.
    const chats = page.getByTestId('topic-chats').getByTestId('topic-chat')
    await expect(chats.filter({ hasText: 'Fixture app' })).toHaveCount(1)
    await expect(chats.filter({ hasText: 'Blog publish' })).toHaveCount(1)
    await expect(chats.filter({ hasText: 'Morning brief' })).toHaveCount(0)
    await chats.filter({ hasText: 'Fixture app' }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000004$/)
  })

  test('the chevron folds a topic without opening it', async ({ page }) => {
    // Scoped to the sidebar: Today's inbox names the same chat in its rows.
    const side = page.locator('aside')
    await side.getByRole('button', { name: 'Collapse ☀️ Daily' }).click()
    await expect(page).toHaveURL(HOME)
    await expect(side.getByText('Morning brief')).toBeHidden()
    await side.getByRole('button', { name: 'Expand ☀️ Daily' }).click()
    await expect(side.getByText('Morning brief')).toBeVisible()
  })

  test('the brief is edited in place and saved', async ({ page }) => {
    await page.getByTitle('Open the topic').filter({ hasText: 'Projects' }).click()
    const brief = page.getByTestId('topic-brief')
    await brief.getByRole('button', { name: 'Edit' }).click()
    const box = brief.getByLabel('Brief')
    await expect(box).toBeVisible()
    await box.fill('**What this is** — e2e rewrote this.\n\n**Open**\n- nothing')
    await brief.getByRole('button', { name: 'Save' }).click()
    await expect(box).toBeHidden()
    await expect(brief.getByText('e2e rewrote this.')).toBeVisible()
    await expect(brief.getByText(/updated just now/)).toBeVisible()
    // Persisted: a reload reads it back from the server.
    await page.reload()
    await expect(page.getByTestId('topic-brief').getByText('e2e rewrote this.')).toBeVisible()
  })

  test('a topic without a brief offers to write one or have Jarvis draft it', async ({ page }) => {
    await page.getByTitle('Open the topic').filter({ hasText: 'Daily' }).click()
    const brief = page.getByTestId('topic-brief')
    await expect(brief.getByText('No brief yet.')).toBeVisible()
    await expect(brief.getByRole('button', { name: 'Write' })).toBeVisible()
    await expect(brief.getByRole('button', { name: 'Generate' })).toBeVisible()
  })

  test('a long brief folds past a max height; Show more unfolds it', async ({ page }) => {
    // Fixtures carries the long brief — its own topic, so the edit test on
    // Projects cannot shorten it from under this one (workers run in parallel).
    await page.getByTitle('Open the topic').filter({ hasText: 'Fixtures' }).click()
    const brief = page.getByTestId('topic-brief')
    const body = brief.getByTestId('topic-brief-body')
    const more = brief.getByRole('button', { name: 'Show more' })
    await expect(more).toBeVisible()
    // Folded: the last lines are clipped, the rest of the page stays near.
    const folded = await body.boundingBox()
    expect(folded!.height).toBeLessThanOrEqual(230)
    await expect(brief.getByText('Week 38: the second app')).not.toBeInViewport()
    await more.click()
    const open = await body.boundingBox()
    expect(open!.height).toBeGreaterThan(folded!.height + 60)
    await expect(brief.getByText('Week 38: the second app')).toBeVisible()
    await brief.getByRole('button', { name: 'Show less' }).click()
    await expect(more).toBeVisible()
  })

  test('a group that is not a topic hides its brief, and can take it back', async ({ page }) => {
    // Its own throwaway topic: the no-brief test reads Daily at the same time.
    const name = `e2e folder ${Date.now().toString(36)}`
    await page.getByText('New topic').click()
    await page.getByPlaceholder('Work, Home, a project…').fill(name)
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByTitle('Open the topic').filter({ hasText: name }).click()
    const brief = page.getByTestId('topic-brief')
    await expect(brief.getByText('No brief yet.')).toBeVisible()
    await brief.getByRole('button', { name: 'Hide' }).click()
    await expect(brief.getByText('A group without a brief')).toBeVisible()
    await expect(brief.getByRole('button', { name: 'Write' })).toHaveCount(0)
    // Persisted: a reload keeps it hidden.
    await page.reload()
    const again = page.getByTestId('topic-brief')
    await expect(again.getByText('A group without a brief')).toBeVisible()
    await again.getByRole('button', { name: 'Use a brief' }).click()
    await expect(again.getByText('No brief yet.')).toBeVisible()
    // Leave the instance as found.
    page.once('dialog', (d) => d.accept())
    await page.getByRole('main').getByTitle('Topic options').click()
    await page.getByRole('button', { name: 'Delete topic' }).click()
    await expect(page).toHaveURL(HOME)
  })

  test('new chat here lands in the topic', async ({ page }) => {
    await page.getByTitle('Open the topic').filter({ hasText: 'Projects' }).click()
    await page.getByRole('button', { name: 'New chat here' }).click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
    const id = page.url().match(/\/c\/([0-9a-f-]{36})$/)![1]
    // Back on the topic, the new chat is listed under it.
    await page.goBack()
    await expect(page.getByTestId('topic-chats').getByTestId('topic-chat').filter({ hasText: 'New conversation' }).first()).toBeVisible()
    // Leave the instance as found: the menu's Delete opens the dialog, whose
    // own Delete does it (files archived, no routines to ask about).
    await page.goto(`c/${id}`)
    await page.getByRole('main').locator('button[title*="onversation options"]:visible').first().click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(page).toHaveURL(HOME)
  })
})
