import { test, expect, signIn, openConversation } from '../helpers'
import type { Page } from '@playwright/test'

/**
 * A turn streaming in, driven from the page: the app's EventSource is wrapped
 * so the test can hand it the same events the backend sends (`thinking`,
 * `delta`). The stub engine never runs a turn, so this is the only way to see
 * the list grow under the reader.
 */
test.describe('streaming', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const Real = window.EventSource
      const open: EventSource[] = []
      ;(window as unknown as { __sse: EventSource[] }).__sse = open
      window.EventSource = class extends Real {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          open.push(this)
        }
      } as typeof EventSource
    })
    await signIn(page)
  })

  async function emit(page: Page, ev: object): Promise<void> {
    await page.evaluate((data) => {
      for (const es of (window as unknown as { __sse: EventSource[] }).__sse) {
        if (es.readyState !== EventSource.CLOSED) es.onmessage?.(new MessageEvent('message', { data }))
      }
    }, JSON.stringify(ev))
  }

  // Several lines per chunk, so each one grows the list by a visible amount.
  async function stream(page: Page, from: number, to: number): Promise<void> {
    for (let n = from; n <= to; n++) {
      await emit(page, { type: 'delta', text: `Streamed line ${n}: ${'more words to wrap onto another line. '.repeat(4)}\n\n` })
      await page.waitForTimeout(60)
    }
    // Let the typewriter catch up with what arrived.
    await page.waitForTimeout(600)
  }

  /** The top of the first paragraph fully in view, and its text. */
  function visibleLine(page: Page) {
    return page.getByTestId('chat-scroll').evaluate((box) => {
      const r = box.getBoundingClientRect()
      const p = [...box.querySelectorAll('p')].find((el) => {
        const b = el.getBoundingClientRect()
        return b.top >= r.top + 40 && b.bottom <= r.bottom - 40
      })
      return p ? { text: p.textContent, top: p.getBoundingClientRect().top } : null
    })
  }

  test('scrolled up, the text stays still while the answer streams; at the bottom it follows again', async ({ page }) => {
    await openConversation(page, 'Markdown showcase')
    await expect(page.getByText('a quote, to close.')).toBeInViewport()
    await emit(page, { type: 'thinking', thinking: true })

    // At the bottom: the stream is followed.
    await stream(page, 1, 4)
    await expect(page.getByText('Streamed line 4:')).toBeInViewport()

    // Up a little, reading: what is under the eyes does not move, by a pixel.
    await page.getByTestId('chat-scroll').hover()
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(300)
    const before = await visibleLine(page)
    expect(before).not.toBeNull()
    await stream(page, 5, 20)
    const after = await page.getByTestId('chat-scroll').evaluate((box, text) => {
      const p = [...box.querySelectorAll('p')].find((el) => el.textContent === text)
      return p?.getBoundingClientRect().top
    }, before!.text)
    expect(after).toBe(before!.top)
    await expect(page.getByText('Streamed line 20:')).not.toBeInViewport()
    await expect(page.getByTestId('jump-to-bottom')).toBeVisible()

    // All the way down again: back to following.
    await page.mouse.wheel(0, 100_000)
    await page.waitForTimeout(300)
    await stream(page, 21, 28)
    await expect(page.getByText('Streamed line 28:')).toBeInViewport()
    await expect(page.getByTestId('jump-to-bottom')).toBeHidden()

    await emit(page, { type: 'thinking', thinking: false })
  })

  test('scrolled up, an older page landing above does not move the text either', async ({ page }) => {
    // The showcase is short: the page is served with "more above", and two
    // pages of made-up history are handed out by the test — the first one at
    // once, the second only once the reader has settled somewhere.
    type Msg = { id: string; conversation_id: string; role: string; content: string; result?: string | null; created_at: number; seq: number }
    let oldest: Msg | undefined
    const fake = (from: number, to: number): Msg[] => {
      const out: Msg[] = []
      for (let n = to; n >= from; n--) {
        const text = `Older answer ${n}: ${'history that fills the screen above. '.repeat(6)}`
        const base = { conversation_id: oldest!.conversation_id, created_at: oldest!.created_at - n * 60_000 }
        out.push({ ...base, id: `older-q-${n}`, role: 'user', content: `Older question ${n}?`, seq: -2 * n - 1 })
        out.push({ ...base, id: `older-a-${n}`, role: 'assistant', content: `[chunk:1] ${text}`, result: text, seq: -2 * n })
      }
      return out
    }
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    await page.route(/\/api\/conversations\/[0-9a-f-]{36}(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      const body = await res.json()
      if (body.title !== 'Markdown showcase') return route.fulfill({ response: res })
      oldest = body.messages[0]
      await route.fulfill({ response: res, json: { ...body, has_more: true } })
    })
    await page.route(/\/messages\?before=/, async (route) => {
      const before = Number(new URL(route.request().url()).searchParams.get('before'))
      if (before > 0) return route.fulfill({ json: { messages: fake(1, 10), has_more: true } })
      await held
      await route.fulfill({ json: { messages: fake(11, 20), has_more: false } })
    })

    await openConversation(page, 'Markdown showcase')
    await expect(page.getByText('Older answer 1:')).toBeAttached()
    // Up among the first page, near enough to the top that the next one loads.
    await page.getByText('Older answer 8:').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    const before = await visibleLine(page)
    expect(before).not.toBeNull()
    release()
    await expect(page.getByText('Older answer 20:')).toBeAttached()
    await page.waitForTimeout(300)
    const after = await page.getByTestId('chat-scroll').evaluate((box, text) => {
      const p = [...box.querySelectorAll('p')].find((el) => el.textContent === text)
      return p?.getBoundingClientRect().top
    }, before!.text)
    expect(Math.abs(after! - before!.top)).toBeLessThanOrEqual(1)
  })
})
