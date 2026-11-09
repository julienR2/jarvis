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

  test('slash commands: "/" opens the menu, typing filters it, a pick fills the input', async ({ page }) => {
    await openConversation(page, 'Markdown showcase')
    const input = page.getByPlaceholder('How can I help you today?')
    const menu = page.getByTestId('slash-menu')
    await input.fill('/')
    // The instance's skills and the CLI's own commands, one list for every model.
    await expect(menu.getByRole('option')).toHaveCount(4)
    await expect(menu.getByRole('option', { name: /\/gmail/ })).toBeVisible()
    // Two groups, told apart at a glance: skills first, then the CLI's own.
    await expect(menu.getByTestId('slash-group-skills')).toHaveText('Skills')
    await expect(menu.getByTestId('slash-group-builtin')).toHaveText('Claude Code')
    await expect(menu.getByRole('option', { name: /\/compact/ })).toHaveAttribute('data-kind', 'builtin')
    await expect(menu.getByRole('option').first()).toHaveAttribute('data-kind', 'skill')
    await input.fill('/co')
    await expect(menu.getByRole('option')).toHaveCount(2)
    await expect(menu.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
    await input.press('ArrowDown')
    await input.press('Enter')
    // Picked, not sent: the command's arguments go after it.
    await expect(input).toHaveValue('/context ')
    await expect(menu).toBeHidden()
    // Escape closes it without touching the text.
    await input.fill('/g')
    await expect(menu).toBeVisible()
    await input.press('Escape')
    await expect(menu).toBeHidden()
    await expect(input).toHaveValue('/g')
  })

  test('activity: only the answer — no step line, no trail to unfold', async ({ page }) => {
    const opened = page.waitForResponse((r) => /\/api\/conversations\/[^/?]+(\?|$)/.test(r.url()) && r.request().method() === 'GET')
    await openConversation(page, 'Activity steps')
    await expect(page.getByText('10 photos')).toBeVisible()
    // Prose Jarvis wrote on the way is part of the answer and stays.
    await expect(page.getByText('Found the folder, counting per day now.')).toBeVisible()
    // The steps don't even travel: the page carries the prose, not the log.
    const sent = JSON.stringify((await (await opened).json()).messages)
    expect(sent).toContain('Found the folder')
    expect(sent).not.toMatch(/\[(tool|note)(:\d+)?\] /)
    expect(sent).not.toContain('Counting is done')
    // The machinery leaves no trace once the turn is over: no count, no notes,
    // no tool calls, nothing to click open.
    await expect(page.getByText(/\d+ steps?\b/)).toHaveCount(0)
    await expect(page.getByTitle('Show the steps')).toHaveCount(0)
    await expect(page.getByText('Twelve files, but two are duplicates by hash')).toHaveCount(0)
    await expect(page.getByText('ls /workspace/gallery/2026-09')).toHaveCount(0)
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
    await expect(block.getByRole('button', { name: 'Mark unread from here' })).toHaveCount(1)
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

  test('the model picker lives in the input, not the ⋯ menu', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    await page.getByRole('main').locator('button[title*="onversation options"]:visible').first().click()
    await expect(page.getByRole('switch', { name: 'Think hard' })).toHaveCount(0)
    await expect(page.getByText('Notifications')).toBeVisible()
    await page.keyboard.press('Escape')
    // Opens above the input; think hard is off by default and switches on for
    // the next message (saved only by sending it).
    await page.getByRole('main').getByTitle('Model').click()
    const sw = page.getByRole('switch', { name: 'Think hard' })
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
  })

  test('an answer names its model only where it changed', async ({ page }) => {
    await openConversation(page, 'Quoted reply')
    await expect(page.getByText('· Haiku 4.5')).toHaveCount(1)
    await expect(page.getByText(/· Opus/)).toHaveCount(0)
  })

  test('background run: the gear opens the routine, in its thread', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    await page.getByTestId('run-card').getByTitle('Open this routine').click()
    await expect(page).toHaveURL(/\/c\/.+\?routine=open/)
    await expect(page.getByTestId('routine-card').locator('visible=true').first().getByLabel('Prompt')).toHaveValue('Write the morning brief.')
  })

  test('the # list holds the routines of the chat beside its threads: when they run, paused or not, one click to each', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    // Nothing about routines in the title bar while nothing runs, nor in the ⋯ menu: they live in the # list.
    await expect(page.getByRole('main').getByTestId('runs-pill')).toHaveCount(0)
    await page.getByRole('main').getByTitle('Conversation options').locator('visible=true').first().click()
    await expect(page.getByTestId('chat-routines')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="threads-pill"]:visible').click()
    const list = page.getByTestId('threads-popover').getByTestId('chat-routines')
    const row = list.getByTestId('chat-routines-row').filter({ hasText: 'morning-brief' })
    await expect(row).toHaveCount(1)
    await expect(row.getByText('daily at 05:30')).toBeVisible()
    await expect(row.getByRole('switch', { name: 'Resume morning-brief' })).toHaveAttribute('aria-checked', 'false')
    await expect(list.getByRole('button', { name: 'New routine here' })).toBeVisible()
    await expect(list.getByRole('button', { name: 'Open in Routines' })).toBeVisible()
    await row.getByRole('button', { name: 'Settings of morning-brief' }).click()
    await expect(page).toHaveURL(/\?routine=open/)
    await expect(page.getByTestId('routine-card').locator('visible=true').first().getByLabel('Prompt')).toHaveValue('Write the morning brief.')
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

  test('delete: the dialog asks about what the chat has — here a routine, off by default; Cancel keeps everything', async ({ page }) => {
    await openConversation(page, 'Morning brief')
    await page.getByRole('main').locator('button[title*="onversation options"]:visible').first().click()
    await page.getByRole('button', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Delete this chat?')).toBeVisible()
    const routines = dialog.getByRole('switch', { name: /Also delete its routine/ })
    await expect(routines).toHaveAttribute('aria-checked', 'false')
    await expect(dialog.getByText('Otherwise they keep running and open a new chat')).toBeVisible()
    // No uploads, no app: nothing to ask about files.
    await expect(dialog.getByRole('switch', { name: /Also delete .*file|app/ })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/000000000003$/)
  })

  test('delete: a chat with nothing attached is just asked to confirm, and Delete removes it', async ({ page }) => {
    await openConversation(page, 'Scratch')
    await page.getByRole('main').locator('button[title*="onversation options"]:visible').first().click()
    await page.getByRole('button', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Delete this chat?')).toBeVisible()
    await expect(dialog.getByRole('switch')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(page).toHaveURL(/^https?:\/\/[^/]+\/?$/)
    await expect(page.getByRole('complementary').getByText('Scratch', { exact: true })).toHaveCount(0)
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

  test('app pane: Chat and App toggle each pane on desktop, and each chat keeps its own choice', async ({ page }) => {
    await openConversation(page, 'Fixture app')
    const main = page.getByRole('main')
    const app = page.locator('iframe[title="App preview"]')
    const composer = page.getByPlaceholder('How can I help you today?')
    await expect(app).toBeVisible()
    await expect(composer).toBeVisible()

    // Both on by default, the app under its own bar with refresh and open…
    const previewBar = main.getByTitle('Refresh preview', { exact: true })
    await expect(previewBar).toBeVisible()
    // …switching one off leaves the other alone, and the app alone has only
    // the title bar, its actions in the ⋯ menu, as on a phone.
    await main.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(composer).toBeHidden()
    await expect(app).toBeVisible()
    await expect(previewBar).toBeHidden()
    await main.locator('[title="Conversation options"]:visible').click()
    await expect(page.getByRole('button', { name: 'Refresh preview' })).toBeVisible()
    await page.keyboard.press('Escape')
    // …and the last pane standing can't be switched off.
    await main.getByRole('button', { name: 'App', exact: true }).click()
    await expect(app).toBeVisible()

    // Another app chat is untouched, and coming back finds the app alone.
    await openConversation(page, 'Second app')
    await expect(composer).toBeVisible()
    await expect(app).toBeVisible()
    await openConversation(page, 'Fixture app')
    await expect(composer).toBeHidden()
    await expect(app).toBeVisible()

    // Leave the instance as found.
    await main.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(composer).toBeVisible()
  })

  test('app pane: on a phone a swipe right on the app opens the sidebar — unless the app can scroll that way', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('c/00000000-0000-4000-8000-000000000004')
    const frame = (await page.locator('iframe[title="App preview"]').contentFrame())!
    await expect(frame.getByTestId('fixture-app')).toBeVisible()
    const sidebar = page.getByRole('complementary').getByText('New chat')
    await expect(sidebar).not.toBeInViewport()

    // A finger dragged across the frame, as the browser would report it there.
    const swipe = (selector: string) => frame.locator(selector).evaluate(async (target) => {
      const touch = (x: number) => [new Touch({ identifier: 1, target, clientX: x, clientY: 400 })]
      const fire = (type: string, x: number) => target.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : touch(x), changedTouches: touch(x),
      }))
      fire('touchstart', 60)
      for (let x = 90; x <= 330; x += 40) {
        fire('touchmove', x)
        await new Promise((r) => setTimeout(r, 16))
      }
      fire('touchend', 330)
    })

    // A scroller of the app's own, scrolled in a bit: the swipe is the app's.
    await frame.locator('body').evaluate((body) => {
      const sc = document.createElement('div')
      sc.id = 'scroller'
      sc.style.cssText = 'position:fixed;inset:0;overflow-x:auto'
      sc.innerHTML = '<div style="width:2000px;height:100%"></div>'
      body.append(sc)
      sc.scrollLeft = 200
    })
    await swipe('#scroller')
    await page.waitForTimeout(400)
    await expect(sidebar).not.toBeInViewport()

    // Nothing of the app's to scroll: the swipe opens the sidebar.
    await frame.locator('#scroller').evaluate((sc) => sc.remove())
    await swipe('main')
    await expect(sidebar).toBeInViewport()
  })

  test('app pane: on a phone it opens on the app, and a chat switched to Chat stays there', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const app = page.locator('iframe[title="App preview"]')
    const composer = page.getByPlaceholder('How can I help you today?')
    await page.goto('c/00000000-0000-4000-8000-000000000004')
    await expect(app).toBeVisible()
    await expect(composer).toBeHidden()
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await expect(composer).toBeVisible()
    await expect(app).toBeHidden()

    await page.goto('c/00000000-0000-4000-8000-000000000008')
    await expect(app).toBeVisible()
    await page.goto('c/00000000-0000-4000-8000-000000000004')
    await expect(composer).toBeVisible()
    await expect(app).toBeHidden()
  })

  test('voice message: "Transcribing…" lasts as long as the transcription, and my bubble lands as it ends', async ({ page }) => {
    // A chat of its own: the message sent here must not show up in the fixtures.
    const res = await page.request.post('api/conversations', {
      headers: { Authorization: `Bearer ${process.env.E2E_TOKEN}` },
      data: {},
    })
    const { id } = await res.json()
    await page.goto(`c/${id}`)
    await page.getByTitle('Tap to record').click()
    await page.waitForTimeout(500)
    await page.getByTitle('Send voice message').click()

    // The stub's Whisper takes 1.5 s: all that time the composer says so and
    // the chat has no bubble yet…
    const transcribing = page.getByText('Transcribing…')
    const bubble = page.getByText('Voice note from the e2e microphone')
    await expect(transcribing).toBeVisible()
    await page.waitForTimeout(800)
    await expect(transcribing).toBeVisible()
    await expect(bubble).toHaveCount(0)
    // …then the bubble is there the moment "Transcribing…" goes, not seconds after.
    await expect(transcribing).toBeHidden({ timeout: 5_000 })
    await expect(bubble).toBeVisible({ timeout: 300 })
  })
})
