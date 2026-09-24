import { test, expect, signIn } from '../helpers'

/**
 * The home page: a greeting and the composer, then the unreads — one card per
 * chat with something new, ordered by what it asks of you. Fixtures: two runs
 * and one chat waiting on the person, the yearly cron's run failed with nothing
 * succeeding since (all "action"), "📣 Gallery sync" notified and unread,
 * "💬 Pasta water" merely unread (one exchange read, one new), "💬 Bike tyre
 * pressure" unread and consumed by the mark-read test. No other spec opens
 * those three, so their read state survives whatever order the workers run in.
 */
test.describe('today', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('the greeting and the composer come first, the composer is not focused, and the inbox follows', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening|night)$/ })).toBeVisible()
    const composer = page.getByPlaceholder('How can I help you today?')
    await expect(composer).toBeVisible()
    await expect(composer).not.toBeFocused()
    const inbox = page.getByTestId('today-inbox')
    const [c, s] = await Promise.all([composer.boundingBox(), inbox.boundingBox()])
    expect(c && s && c.y < s.y).toBeTruthy()
    // A small separator between the two, the composer as wide as the cards.
    const sep = await page.getByTestId('today-separator').boundingBox()
    expect(sep && c && s && c.y < sep.y && sep.y < s.y).toBeTruthy()
    // The header of a card is one line: the chat's name and its topic.
    const row = inbox.getByTestId('today-row').first()
    const head = await row.locator('button[aria-expanded]').boundingBox()
    expect(head!.height).toBeLessThan(32)
    // Gone from home: Coming up, the quiet-runs line, the setup wizard link.
    await expect(page.getByText('Coming up')).toBeHidden()
    await expect(page.getByText(/had nothing to report/)).toBeHidden()
    await expect(page.getByText('Setup wizard')).toBeHidden()
  })

  test('order: what waits on you, then what was worth a notification, then the merely unread', async ({ page }) => {
    const cards = page.getByTestId('today-inbox').getByTestId('today-row')
    // Reply to Marta: the one waiting chat no spec ever answers.
    const action = cards.filter({ hasText: 'Reply to Marta' })
    const failed = cards.filter({ hasText: 'greetings API answered 503' })
    const notified = cards.filter({ hasText: 'Gallery sync' })
    const unread = cards.filter({ hasText: 'Pasta water' })
    await expect(action).toHaveAttribute('data-reason', 'action')
    await expect(failed).toHaveAttribute('data-reason', 'action')
    await expect(notified).toHaveAttribute('data-reason', 'notified')
    await expect(unread).toHaveAttribute('data-reason', 'unread')
    const [a, f, n, u] = await Promise.all([action.boundingBox(), failed.boundingBox(), notified.boundingBox(), unread.boundingBox()])
    expect(a!.y).toBeLessThan(n!.y)
    expect(f!.y).toBeLessThan(n!.y)
    expect(n!.y).toBeLessThan(u!.y)
    // No section headings: the order carries the meaning.
    await expect(page.getByRole('heading', { name: /Needs you|Worth telling you|Unread/ })).toHaveCount(0)
  })

  test('a card shows what is new, drawn like the chat, with earlier messages a click away', async ({ page }) => {
    const card = page.getByTestId('today-inbox').getByTestId('today-row').filter({ hasText: 'Pasta water' })
    await expect(card).toHaveAttribute('data-status', 'unread')
    // Open by default: the new exchange, not the one already read.
    await expect(card.getByText('Two to three minutes once it floats')).toBeVisible()
    await expect(card.getByText('And how long for fresh tagliatelle?')).toBeVisible()
    await expect(card.getByText('a tablespoon of salt per litre')).toHaveCount(0)
    await card.getByRole('button', { name: 'Show earlier' }).click()
    await expect(card.getByText('a tablespoon of salt per litre')).toBeVisible()
    // The chat's own composer, compact, to reply from here.
    await expect(card.getByPlaceholder('Reply…')).toBeVisible()
    await expect(card.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  })

  test('collapsing a card is "later": the header stays — name, topic, how many new — and the chat stays unread', async ({ page }) => {
    const card = page.getByTestId('today-inbox').getByTestId('today-row').filter({ hasText: 'Gallery sync' })
    await card.getByRole('button', { expanded: true }).click()
    await expect(card.getByTestId('today-row-count')).toHaveText('1 message')
    await expect(card.getByText('Gallery synced: 212 photos')).toHaveCount(0) // no hint: the header stays short
    await expect(card.getByPlaceholder('Reply…')).toHaveCount(0)
    await expect(card).toHaveCount(1)
    await page.reload()
    await expect(page.getByTestId('today-inbox').getByTestId('today-row').filter({ hasText: 'Gallery sync' })).toHaveCount(1)
  })

  test('✓ marks the chat read: the card leaves, the badge too, and it stays that way', async ({ page }) => {
    const card = page.getByTestId('today-inbox').getByTestId('today-row').filter({ hasText: 'Bike tyre pressure' })
    await expect(card).toHaveCount(1)
    const sidebarRow = page.getByRole('complementary').getByText('💬 Bike tyre pressure', { exact: true }).locator('xpath=..')
    await expect(sidebarRow.getByText('1', { exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Mark 💬 Bike tyre pressure as read' }).click()
    await expect(card).toHaveCount(0)
    await expect(sidebarRow.getByText('1', { exact: true })).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('today-inbox')).toBeVisible()
    await expect(page.getByTestId('today-inbox').getByTestId('today-row').filter({ hasText: 'Bike tyre pressure' })).toHaveCount(0)
  })

  test('a failed run: its error, a Retry, and Open app when the chat has one', async ({ page }) => {
    // The only failure in the fixtures; its body text leaves when collapsed.
    const card = page.getByTestId('today-inbox').locator('[data-testid="today-row"][data-status="error"]')
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('button', { name: /Retry/ })).toBeVisible()
    // The run wrote nothing into the chat, so its error is the card's body…
    await expect(card.getByTestId('inbox-error')).toContainText('greetings API answered 503')
    // …and, collapsed, Retry and Open stay on the header.
    await card.getByRole('button', { expanded: true }).click()
    await expect(card.getByRole('button', { name: /Retry/ })).toBeVisible()
    await card.getByRole('button', { name: 'Open app' }).click()
    await expect(page).toHaveURL(/\/c\/00000000-0000-4000-8000-000000000004$/)
  })

  test('the sidebar entry shows one dot, the most urgent — amber while something waits on you', async ({ page }) => {
    await expect(page.getByTestId('activity-waiting')).toHaveCount(1)
    await expect(page.getByTestId('activity-failed')).toHaveCount(0)
    await expect(page.getByTestId('activity-running')).toHaveCount(0)
  })

  test('on a phone the cards keep their actions and nothing overflows', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const card = page.getByTestId('today-inbox').getByTestId('today-row').filter({ hasText: 'greetings API answered 503' })
    await expect(card.getByRole('button', { name: 'Open app' })).toBeVisible()
    await expect(card.getByRole('button', { name: /Retry/ })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(overflow).toBeFalsy()
  })
})
