import { test, expect } from '../helpers'

/**
 * A chat and the thread opened from one of its passages each hear, on their
 * next turn, what the other did meanwhile. Checked on what the backend sends
 * the engine: the stub keeps the last prompt per conversation.
 */
const API = process.env.E2E_API || 'http://127.0.0.1:3105'
const ENGINE = `http://127.0.0.1:${process.env.E2E_ENGINE_PORT || 3110}`
const CHAT = '00000000-0000-4000-8000-000000000017'
const THREAD = '00000000-0000-4000-8000-000000000018'

async function send(conversationId: string, content: string): Promise<string> {
  const res = await fetch(`${API}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.E2E_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  expect(res.ok).toBe(true)
  // The turn is handed to the engine right after the reply.
  for (let i = 0; i < 20; i++) {
    const { prompt } = await (await fetch(`${ENGINE}/__prompt/${conversationId}`)).json() as { prompt: string | null }
    if (prompt?.includes(content)) return prompt
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('the engine never received the turn')
}

test.describe('a chat and its passage threads', () => {
  test.describe.configure({ mode: 'serial' })

  test("the chat hears what its thread answered since the user last wrote there — once", async () => {
    const prompt = await send(CHAT, 'Where are we on the kit?')
    expect(prompt).toContain('<article data-jarvis="thread-activity">')
    expect(prompt).toContain('Thread "Call kit"')
    expect(prompt).toContain('The call kit is ready')
    expect(prompt).toContain('/jarvis/agent/workspace/uploads/kit/kit.md')
    // Told once: the next turn starts after it.
    const next = await send(CHAT, 'Thanks.')
    expect(next).not.toContain('thread-activity')
  })

  test('the thread hears what the chat said since it last spoke', async () => {
    const prompt = await send(THREAD, 'Add the doctor to the kit.')
    expect(prompt).toContain('<article data-jarvis="parent-chat-activity">')
    expect(prompt).toContain('Dr Martin is the treating doctor')
    // From before the thread was opened: the fork already carried it.
    expect(prompt).not.toContain('Six documents')
  })
})
