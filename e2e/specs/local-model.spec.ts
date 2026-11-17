import { test, expect, signIn } from '../helpers'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * The Local provider, end to end: a chat on a local model talks to the
 * OpenAI-compatible server directly — the stub engine plays it, on its own
 * port — and never to the engine; and a chat that has run on one stays out of
 * every path that would carry its content off the machine.
 *
 * Serial: the first test configures the local server, the rest use it, and
 * the last removes it so no other spec sees a Local section in its picker.
 */
const API = process.env.E2E_API || 'http://127.0.0.1:3105'
const ENGINE = `http://127.0.0.1:${process.env.E2E_ENGINE_PORT || 3110}`
const MODEL = 'local:stub-gemma'
// The run's own secrets.json sits next to the credentials file (stack.sh).
const internalSecret = () =>
  (JSON.parse(readFileSync(join(dirname(process.env.E2E_CREDENTIALS!), 'secrets.json'), 'utf8')) as { internal: string }).internal

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.E2E_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function internal(path: string): Promise<Response> {
  return fetch(`${API}/internal${path}`, { headers: { 'X-Internal-Secret': internalSecret() } })
}

async function localRequests(): Promise<Array<{ messages: { role: string; content: string }[]; stream?: boolean }>> {
  return ((await (await fetch(`${ENGINE}/__local/requests`)).json()) as { requests: never[] }).requests
}

async function enginePrompt(conversationId: string): Promise<string | null> {
  return ((await (await fetch(`${ENGINE}/__prompt/${conversationId}`)).json()) as { prompt: string | null }).prompt
}

/** The conversation's messages, newest last, once `until` holds. */
async function messagesWhen(id: string, until: (m: Array<{ role: string; type: string | null; content: string; result: string | null; model: string | null; metadata: string | null }>) => boolean) {
  for (let i = 0; i < 100; i++) {
    const { messages } = (await (await api('GET', `/conversations/${id}`)).json()) as { messages: Parameters<typeof until>[0] }
    if (until(messages)) return messages
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the conversation never got there')
}

test.describe('local models', () => {
  test.describe.configure({ mode: 'serial' })
  let chatId = ''

  test.afterAll(async () => {
    await api('DELETE', '/auth/connection/local')
  })

  test('Settings verifies the local server and its models join the picker', async ({ page }) => {
    await signIn(page)
    await page.goto('settings/customize')
    const card = page.getByTestId('local-provider')
    await card.getByRole('button', { name: /Local/ }).click()
    await card.getByLabel('Local server URL').fill(`${ENGINE}/v1`)
    await card.getByRole('button', { name: 'Verify and save' }).click()
    await expect(card.getByText(/Verified and saved — stub-gemma/)).toBeVisible()
    // Stored at the server root, /v1 stripped.
    await expect(card.getByText(ENGINE, { exact: true })).toBeVisible()

    const models = (await (await api('GET', '/models')).json()) as { local: { id: string; desc: string }[]; default: string }
    expect(models.local.map((m) => m.id)).toEqual([MODEL])
    expect(models.local[0].desc).toContain('4k context')
    // Chosen per conversation, never as the instance default.
    expect(models.default).not.toBe(MODEL)
    const refused = await api('PUT', '/auth/connection/defaults', { anthropicModel: MODEL })
    expect(refused.status).toBe(400)
  })

  test('a chat on a local model streams its answer without the agent, and reads a shared file inline', async ({ page }) => {
    await signIn(page)
    await page.getByText('New chat').first().click()
    await page.getByRole('main').getByTitle('Model').click()
    const local = page.getByTestId('local-models')
    await expect(local.getByText('Local — private, no tools')).toBeVisible()
    await local.getByRole('button', { name: /stub-gemma/ }).click()
    // No effort setting for a local model.
    await page.getByRole('main').getByTitle('Model').click()
    await expect(page.getByRole('switch', { name: 'Think hard' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'chat.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('[01/02/2026, 09:14] Alice: On se retrouve à 18h devant la gare ?\n[01/02/2026, 09:15] Bob: Oui 👍\n'),
    })
    const input = page.getByPlaceholder('How can I help you today?')
    await input.fill('À quelle heure le rendez-vous ?')
    await input.press('Enter')

    // A first message is titled before it is answered (one request at a time
    // on a home server), so its answer comes after two round-trips: slower
    // than one assertion's default wait on a loaded machine.
    await expect(page.getByText(/Local answer: I was sent 2 messages/)).toBeVisible({ timeout: 20_000 })
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
    chatId = page.url().split('/c/')[1]

    // What the server got: a system prompt, then the file inline and the question.
    const sent = (await localRequests()).filter((r) => r.stream).pop()!
    expect(sent.messages[0].role).toBe('system')
    expect(sent.messages[0].content).toContain('You have no tools')
    expect(sent.messages[1].content).toContain('<file name="chat.txt">')
    expect(sent.messages[1].content).toContain('On se retrouve à 18h devant la gare')
    expect(sent.messages[1].content).toContain('À quelle heure le rendez-vous ?')
    // …and the engine got nothing.
    expect(await enginePrompt(chatId)).toBeNull()

    // Titled by the local model, behind the scenes.
    await expect(page.getByText('Stub private title').first()).toBeVisible()
    // The saved answer reads the same as the streamed one did.
    await page.reload()
    await expect(page.getByText(/Local answer: I was sent 2 messages/)).toBeVisible()
    await expect(page.getByRole('main').getByTitle('Model')).toContainText('stub-gemma')
    const messages = await messagesWhen(chatId, (m) => m.some((x) => x.role === 'assistant' && x.result))
    const user = messages.find((m) => m.role === 'user')!
    expect(user.model).toBe(MODEL)
    // The file moved out of the agent's workspace, and is still served.
    const att = JSON.parse(user.metadata!).attachments[0] as { url: string; path: string }
    expect(att.url).toMatch(/^\/api\/uploads\/private\//)
    expect(att.path).not.toContain('/workspace/')
    const file = await fetch(`${API}${att.url}?token=${process.env.E2E_TOKEN}`)
    expect(await file.text()).toContain('devant la gare')
  })

  test('a follow-up carries the history; the private chat refuses Claude and stays invisible to the agent', async () => {
    expect(chatId).not.toBe('')
    const follow = await api('POST', `/conversations/${chatId}/messages`, { content: 'Et qui confirme ?', model: MODEL })
    expect(follow.ok).toBe(true)
    await messagesWhen(chatId, (m) => m.filter((x) => x.role === 'assistant' && x.result).length >= 2)
    const sent = (await localRequests()).filter((r) => r.stream).pop()!
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(sent.messages[1].content).toContain('devant la gare')

    // Sent to Claude: refused with an explanation, and still nothing to the engine.
    const claude = await api('POST', `/conversations/${chatId}/messages`, { content: 'Résume pour Claude', model: 'claude-opus-5-5' })
    expect(claude.ok).toBe(true)
    const after = await messagesWhen(chatId, (m) => m.some((x) => x.type === 'error'))
    expect(after.find((x) => x.type === 'error')!.content).toContain('This conversation is private')
    expect(await enginePrompt(chatId)).toBeNull()
    // The conversation keeps its local model as where the composer starts.
    const conv = (await (await api('GET', `/conversations/${chatId}`)).json()) as { model: string; is_private: number }
    expect(conv.model).toBe(MODEL)
    expect(conv.is_private).toBe(1)

    // The agent's API: not listed, not searchable, not readable, not writable.
    const list = (await (await internal('/conversations?limit=200')).json()) as { id: string }[]
    expect(list.map((c) => c.id)).not.toContain(chatId)
    expect((await internal(`/conversations/${chatId}`)).status).toBe(404)
    expect((await internal(`/conversations/${chatId}/messages`)).status).toBe(404)
    const search = (await (await internal(`/search?q=${encodeURIComponent('devant la gare')}`)).json()) as { messages: unknown[]; conversations: unknown[] }
    expect(search.messages).toEqual([])
    const titles = (await (await internal(`/search?q=${encodeURIComponent('Stub private')}`)).json()) as { conversations: unknown[] }
    expect(titles.conversations).toEqual([])
  })

  test('a long input shows what the server is reading, then gives way to the answer', async ({ page }) => {
    await signIn(page)
    await page.goto(`c/${chatId}`)
    const long = Array.from({ length: 2000 }, (_, i) => `mot${i}`).join(' ')
    const res = await api('POST', `/conversations/${chatId}/messages`, { content: long, model: MODEL })
    expect(res.ok).toBe(true)
    // The stub reports progress for ~4 s: the status is a percentage by then.
    await expect(page.getByText(/^Reading [\d,]+ tokens — \d+%/)).toBeVisible()
    await expect(page.getByText(/the last one 14\d{3} characters long/)).toBeVisible()
    await expect(page.getByText(/^Reading /)).toHaveCount(0)
    // The status was never part of the record.
    const messages = await messagesWhen(chatId, (m) => m.filter((x) => x.role === 'assistant' && x.result).length >= 3)
    expect(messages.filter((m) => m.role === 'assistant').every((m) => !m.content.includes('Reading'))).toBe(true)
  })

  test('a message too long for the window is refused with numbers, not sent', async () => {
    const before = (await localRequests()).length
    const long = Array.from({ length: 5000 }, (_, i) => `mot${i}`).join(' ')
    const res = await api('POST', `/conversations/${chatId}/messages`, { content: long, model: MODEL })
    expect(res.ok).toBe(true)
    const messages = await messagesWhen(chatId, (m) => m.filter((x) => x.type === 'error').length >= 2)
    const error = messages.filter((x) => x.type === 'error').pop()!
    expect(error.content).toContain('too long for the local model')
    expect(error.content).toContain('4,096')
    expect((await localRequests()).length).toBe(before)
  })

  test('a thread opened from a private chat runs on its local model too', async () => {
    const { messages } = (await (await api('GET', `/conversations/${chatId}`)).json()) as { messages: { id: string; role: string; result: string | null }[] }
    const answer = messages.find((m) => m.role === 'assistant' && m.result)!
    const res = await api('POST', `/conversations/${chatId}/threads`, {
      content: 'Détaille ce point',
      reply_to: { message_id: answer.id, text: answer.result },
      model: 'claude-opus-5-5',
    })
    expect(res.ok).toBe(true)
    const thread = (await res.json()) as { id: string; model: string }
    expect(thread.model).toBe(MODEL)
    await messagesWhen(thread.id, (m) => m.some((x) => x.role === 'assistant' && x.result))
    expect(await enginePrompt(thread.id)).toBeNull()
  })
})
