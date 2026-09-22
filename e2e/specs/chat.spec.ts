import { test, expect, signIn, openConversation } from '../helpers'

test.describe('chat rendering', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('markdown: headings, table, code, lists', async ({ page }) => {
    await openConversation(page, 'Markdown showcase')
    await expect(page.getByRole('heading', { name: 'Headings, lists, code' })).toBeVisible()
    await expect(page.locator('table')).toBeVisible()
    await expect(page.locator('pre code')).toContainText('const answer = 42')
    await expect(page.getByText('nested')).toBeVisible()
    await expect(page.getByRole('link', { name: 'link' })).toHaveAttribute('href', 'https://example.com')
  })

  test('activity: folded to one line, notes on a click, steps on another, a note folds it back', async ({ page }) => {
    await openConversation(page, 'Activity steps')
    // The answer is the point; the machinery is one line.
    await expect(page.getByText('10 photos')).toBeVisible()
    const line = page.getByRole('button', { name: /3 steps · 2 notes/ })
    await expect(line).toBeVisible()
    await expect(page.getByRole('button', { name: /^2 steps$/ })).toBeHidden()

    // Unfold: the notes in full, tool calls still folded.
    await line.click()
    const note = page.getByText('Twelve files, but two are duplicates by hash')
    await expect(note).toBeVisible()
    const steps = page.getByRole('button', { name: /^2 steps$/ })
    await expect(steps).toBeVisible()
    await expect(page.getByText('ls /workspace/gallery/2026-09')).toBeHidden()

    // Steps keep their own toggle…
    await steps.click()
    await expect(page.getByText('ls /workspace/gallery/2026-09')).toBeVisible()

    // …and a press on a note folds everything back to the line.
    await note.click()
    await expect(line).toBeVisible()
    await expect(note).toBeHidden()
  })

  test('background run: a normal message under one line of provenance', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    const block = page.getByTestId('run-card')
    await expect(block).toHaveCount(1)
    // Provenance: which routine, and its gear always at hand (there is no hover
    // on a phone). A finished run says nothing about its state, and the time
    // is the message's own, underneath — not repeated on the line.
    await expect(block.getByText('morning-brief')).toBeVisible()
    await expect(block.getByTitle('Open this routine')).toBeVisible()
    await expect(block.getByText(/done ·/)).toHaveCount(0)
    await expect(block.locator('div').first().getByText(/\d{1,2}:\d{2}/)).toHaveCount(0)
    // The answer reads like any other; the routine's prompt is behind a click.
    await expect(block.getByText('Three todos due today')).toBeVisible()
    await expect(block.getByText('Write the morning brief.')).toBeHidden()
    await block.getByRole('button', { name: 'prompt' }).click()
    await expect(block.getByText('Write the morning brief.')).toBeVisible()
    // The conversation's own messages stay outside the block.
    await expect(page.getByText('Court booking opens')).toBeVisible()
  })

  test('background runs with nothing to report print nothing at all', async ({ page }) => {
    await openConversation(page, 'Activity steps')
    // The one that had something to say is a normal block…
    await expect(page.getByTestId('run-card').getByText('Filed under Projects.')).toBeVisible()
    await expect(page.getByTestId('run-card')).toHaveCount(1)
    // …the three silent fires leave no card, no line, no trace.
    await expect(page.getByTestId('quiet-runs')).toHaveCount(0)
    await expect(page.getByText(/nothing to report/)).toHaveCount(0)
    await expect(page.getByText(/JavaScript Weekly/)).toHaveCount(0)
  })

  test('think hard is off by default; the ⋯ menu switches it on per chat, and it sticks', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    await page.getByRole('main').locator('button[title*="onversation options"]:visible').first().click()
    // Reasoning summaries are gone: no such switch any more.
    await expect(page.getByRole('switch', { name: 'Show reasoning' })).toHaveCount(0)
    const sw = page.getByRole('switch', { name: 'Think hard' })
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    // Persisted: reopening the menu after a reload finds it on.
    await page.reload()
    await page.getByRole('main').locator('button[title*="onversation options"]:visible').first().click()
    await expect(page.getByRole('switch', { name: 'Think hard' })).toHaveAttribute('aria-checked', 'true')
  })

  test('background run: the gear opens the routine in edit mode', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    await page.getByTestId('run-card').getByTitle('Open this routine').click()
    await expect(page).toHaveURL(/\/routines/)
    await expect(page.getByRole('heading', { name: 'Edit routine' })).toBeVisible()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('morning-brief')
  })

  test('the title bar names the routines of the chat: pause, run, edit, stop — no page needed', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    // No clock icon, no runs pill: one control, opening to the routines that post here.
    const pill = page.getByRole('main').getByTestId('routines-pill').locator('visible=true').first()
    await pill.click()
    const pop = page.getByTestId('routines-popover')
    const row = pop.getByTestId('routines-popover-row').filter({ hasText: 'morning-brief' })
    await expect(row).toHaveCount(1)
    await expect(row.getByText('daily at 05:30')).toBeVisible()
    await expect(row.getByRole('switch', { name: 'Resume morning-brief' })).toHaveAttribute('aria-checked', 'false')
    await expect(row.getByTitle('Run now')).toBeVisible()
    await expect(pop.getByRole('button', { name: 'New routine here' })).toBeVisible()
    await row.getByTitle('Edit this routine').click()
    await expect(page).toHaveURL(/\/routines/)
    await expect(page.getByRole('heading', { name: 'Edit routine' })).toBeVisible()
  })

  test('unread: the chat opens at the divider; the arrow leads back down and counts what is below', async ({ page }) => {
    // Three answers landed since the thread was last read: the sidebar says so.
    await expect(page.getByText('Unread thread', { exact: true }).locator('xpath=..').getByText('3', { exact: true })).toBeVisible()
    await openConversation(page, 'Unread thread')
    const divider = page.getByRole('button', { name: 'Unread messages' })
    await expect(divider).toBeInViewport()
    // The first unread answer is right under it, the newest one is off screen.
    await expect(page.getByText('Point 4:')).toBeInViewport()
    await expect(page.getByText('Point 6:')).not.toBeInViewport()
    const arrow = page.getByTestId('jump-to-bottom')
    await expect(arrow).toBeVisible()
    await expect(page.getByTestId('jump-to-bottom-count')).toHaveText('3')
    // Down: at the bottom the arrow has nothing left to say.
    await arrow.click()
    await expect(page.getByText('Point 6:')).toBeInViewport()
    await expect(arrow).toBeHidden()
    // The divider is a bookmark: still there after scrolling, gone on a click.
    await page.getByText('Point 4:').scrollIntoViewIfNeeded()
    await expect(divider).toBeVisible()
    await divider.click()
    await expect(divider).toHaveCount(0)
  })

  test('unread: nothing unread means the bottom, no divider, no arrow', async ({ page }) => {
    await openConversation(page, 'Markdown showcase')
    await expect(page.getByText('a quote, to close.')).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Unread messages' })).toHaveCount(0)
    await expect(page.getByTestId('jump-to-bottom')).toBeHidden()
  })

  test('delete: the dialog asks about files and routines, both unchecked; Cancel keeps everything', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    await page.getByRole('main').locator('button[title*="onversation options"]:visible').first().click()
    await page.getByRole('button', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Delete this conversation?')).toBeVisible()
    const files = dialog.getByRole('checkbox', { name: /Also delete the files/ })
    const routines = dialog.getByRole('checkbox', { name: /Also delete its routine/ })
    await expect(files).not.toBeChecked()
    await expect(routines).not.toBeChecked()
    await expect(dialog.getByText('Otherwise they are archived')).toBeVisible()
    await expect(dialog.getByText('Otherwise they keep running and open a new chat')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/000000000003$/)
  })

  test('delete: a chat without routines is asked about its files only, and Delete removes it', async ({ page }) => {
    await page.getByText('New chat').click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
    await page.getByRole('main').locator('button[title*="onversation options"]:visible').first().click()
    await page.getByRole('button', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('checkbox', { name: /Also delete the files/ })).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: /routine/ })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/)
  })

  test('reply to a passage: selecting text offers a reply button that quotes it into the composer', async ({ page }) => {
    await openConversation(page, 'Markdown showcase')
    await expect(page.getByTestId('reply-selection')).toHaveCount(0)
    // Select the whole paragraph, the way a drag would.
    await page.getByText('A paragraph with', { exact: false }).first().evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
    })
    const button = page.getByTestId('reply-selection')
    await expect(button).toBeVisible()
    await button.click()
    const quote = page.getByTestId('composer-quote')
    await expect(quote).toContainText('A paragraph with bold, italic, inline code and a link.')
    // The selection is gone with the click, and so is the button.
    await expect(button).toHaveCount(0)
    await expect(page.getByPlaceholder('How can I help you today?')).toBeFocused()
    await quote.getByRole('button', { name: 'Remove quote' }).click()
    await expect(quote).toHaveCount(0)
  })

  test('reply to a passage: a real answer (activity bubble) is selectable too', async ({ page }) => {
    // Prod answers carry [chunk]/[tool] lines and render through ActivityBubble,
    // which is where the button was missing at first.
    await openConversation(page, 'Quoted reply')
    await page.getByText("A 6'2 shortboard if the swell holds").evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
    })
    const button = page.getByTestId('reply-selection')
    await expect(button).toBeVisible()
    await button.click()
    await expect(page.getByTestId('composer-quote')).toContainText("A 6'2 shortboard")
  })

  test('reply to a passage: the sent message shows the quote, and the quote leads back to its source', async ({ page }) => {
    await openConversation(page, 'Quoted reply')
    const citation = page.getByTestId('reply-citation')
    await expect(citation).toContainText('otherwise the fish, which paddles better in the mush')
    await citation.click()
    await expect(page.getByText("A 6'2 shortboard if the swell holds")).toBeInViewport()
  })

  test('app pane: the fixture app renders beside the chat', async ({ page }) => {
    await openConversation(page, 'Fixture app')
    const frame = page.frameLocator('iframe[title="App preview"]')
    await expect(frame.getByTestId('fixture-app')).toBeVisible()
  })

  test('app pane: switching to another app chat shows that app, with its own token', async ({ page }) => {
    await openConversation(page, 'Fixture app')
    const frame = page.frameLocator('iframe[title="App preview"]')
    await expect(frame.getByTestId('fixture-app')).toBeVisible()
    // The guard fails this test on the 404 the old code provoked here: the
    // second app requested with the first app's token.
    await openConversation(page, 'Second app')
    await expect(frame.getByTestId('fixture-app-two')).toBeVisible()
    await expect(frame.getByTestId('fixture-app')).toHaveCount(0)
    await expect(page.locator('iframe[title="App preview"]')).toHaveAttribute('src', /apps\/fixture-two\//)
    // And back, the same way round.
    await openConversation(page, 'Fixture app')
    await expect(frame.getByTestId('fixture-app')).toBeVisible()
  })
})
