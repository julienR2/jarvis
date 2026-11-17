import { invokeAndWait } from './engine.js'
import { getDb } from './db.js'
import { completeOnce, isLocalModel, localConfig } from './local-llm.js'
import { isPrivateConversation, localModelOf } from './private.js'

// Ask Claude for a short title for the conversation: a one-shot call with a
// fresh session, given the last exchanges from the database in its prompt.
//
// It used to resume the chat's own session for context. Two problems with
// that: the title exchange was appended to the session, so the chat's later
// turns carried every "give this a title" request — and a retry saw its own
// earlier "-" answer and repeated it, forever. And resuming a session under a
// different provider fails. A synthetic conversationId keeps the call's
// running state apart from the chat's.

const PLACEHOLDER = 'New conversation'
export { PLACEHOLDER as UNTITLED }

/**
 * Whether a returned string is plausibly a title rather than an error.
 *
 * The CLI reports some API failures on stdout and exits cleanly, so an error
 * can arrive here looking like a successful result — which is how a
 * conversation ended up titled "API Error: 400 diagnostics.previous_message_id
 * ...". Anything long, multi-line, or announcing itself as an error is not the
 * few words that were asked for.
 */
function looksLikeTitle(raw: string): boolean {
  if (!raw || raw.length > 60 || raw.includes('\n')) return false
  return !/^(api\s+error|error|401|403|404|429|5\d\d)\b/i.test(raw.trim())
}

// The model is asked for a hyphen when there is nothing to name yet — a
// greeting, a test, small talk. Without that rule a "Yo" got a chat titled
// "Salutation sans sujet défini", which is a description, not a title.
const NO_SUBJECT = /^[-–—]+$/

const INSTRUCTIONS = [
  'Title the conversation above: one emoji, then 2 to 3 words naming what the user asked about, in the language the user writes in.',
  'Any question, request or task is a subject — title it, even if the chat opened with a greeting.',
  'Only when there is nothing to name at all (just a greeting or a test, no request yet) reply with a single hyphen.',
  'Reply with the title only — no punctuation, no quotes, no explanation, no tools.',
].join(' ')

// The last exchanges, user text and finished answers only, trimmed so the
// call stays cheap: a title needs the subject, not the whole argument.
function transcript(conversationId: string): string {
  const rows = getDb()
    .prepare(
      `SELECT role, content, result FROM messages
        WHERE conversation_id = ? AND type IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 8`,
    )
    .all(conversationId) as { role: string; content: string; result: string | null }[]
  return rows
    .reverse()
    .map((r) => {
      const text = (r.role === 'assistant' ? r.result ?? '' : r.content).replace(/\s+/g, ' ').trim()
      return text ? `${r.role === 'assistant' ? 'Assistant' : 'User'}: ${text.slice(0, 400)}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * A title for the conversation, or null when there is none to give yet — the
 * caller leaves the placeholder and asks again after the next turn. Null also
 * when the model's answer is unusable: retrying next turn beats a date stamp.
 *
 * The emoji is asked for, not enforced: when the model skips it the words are
 * kept as they are.
 */
export async function generateTitle(
  conversationId: string,
  model?: string | null,
): Promise<string | null> {
  // A private conversation is titled by its own local model, or not by a model
  // at all: the engine would send the transcript to Anthropic or the gateway.
  if (isLocalModel(model) || isPrivateConversation(conversationId)) {
    return localTitle(conversationId, isLocalModel(model) ? (model as string) : localModelOf(conversationId))
  }
  try {
    const lines = transcript(conversationId)
    if (!lines) return null
    const raw = await invokeAndWait({
      prompt: `<transcript>\n${lines}\n</transcript>\n\n${INSTRUCTIONS}`,
      sessionId: null,
      conversationId: `title-${conversationId}`,
      // The conversation's own model: a chat on the gateway is titled by the
      // gateway, so no provider is needed beyond the one the chat already uses.
      model: model ?? undefined,
    })
    return acceptTitle(conversationId, raw)
  } catch (err) {
    console.error(`[title] ${conversationId.slice(0, 8)}: failed`, err)
    return null
  }
}

/** The model's answer as a title, or null to leave the placeholder and ask again. */
function acceptTitle(conversationId: string, raw: string): string | null {
  const cleaned = raw.trim().replace(/^["'«]|["'».,]$/g, '').trim()
  if (NO_SUBJECT.test(cleaned)) {
    console.log(`[title] ${conversationId.slice(0, 8)}: no subject yet (${JSON.stringify(raw.trim())}), asking again next turn`)
    return null
  }
  if (!looksLikeTitle(cleaned)) {
    console.log(`[title] ${conversationId.slice(0, 8)}: refused ${JSON.stringify(raw.slice(0, 120))}`)
    return null
  }
  return cleaned
}

/**
 * Title a private conversation on the local model — once, from its first
 * message, before that message is answered.
 *
 * Before, because a home server usually runs one request at a time and keeps
 * one prompt in its cache: a title asked for after the answer would evict that
 * prompt, and the next question would re-read the whole conversation — minutes,
 * for a long chat export. Once, for the same reason: a local chat is never
 * re-asked for a title. And short: the first message's opening lines and the
 * names of its files, a hundred-odd tokens the server reads in a second or two.
 *
 * When the model has nothing usable (a bare greeting, an error, no server),
 * the first words stand in — never another provider.
 */
async function localTitle(conversationId: string, model: string | null): Promise<string | null> {
  const first = getDb()
    .prepare(
      `SELECT content, metadata FROM messages WHERE conversation_id = ? AND role = 'user' AND type IS NULL
        ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
    .get(conversationId) as { content: string; metadata: string | null } | undefined
  if (!first) return null
  let files: string[] = []
  try {
    files = (JSON.parse(first.metadata ?? '{}').attachments ?? []).map((a: { originalName?: string }) => a.originalName).filter(Boolean)
  } catch { /* no attachments */ }
  const text = first.content.replace(/\s+/g, ' ').trim().slice(0, 300)
  const subject = [text, files.length ? `(files: ${files.join(', ')})` : ''].filter(Boolean).join(' ')
  if (!subject) return null
  const cfg = localConfig()
  if (cfg && model) {
    try {
      const raw = await completeOnce(cfg, model, [
        { role: 'user', content: `<transcript>\nUser: ${subject}\n</transcript>\n\n${INSTRUCTIONS}` },
      ], 24)
      const title = acceptTitle(conversationId, raw)
      if (title) return title
    } catch (err) {
      console.error(`[title] ${conversationId.slice(0, 8)}: local model failed, using the first words`, err)
    }
  }
  return firstWordsTitle(text || files.join(' '))
}

/** The first few words of a text, behind a lock: what a private chat is about, without a model. */
export function firstWordsTitle(text: string): string | null {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4)
  if (words.length === 0) return null
  return `🔒 ${words.join(' ')}`.slice(0, 60)
}

/**
 * A media chat has no Claude session to ask, and its first prompt is the whole
 * subject: the first few words of it, behind the palette.
 */
export function mediaTitle(prompt: string): string | null {
  const words = prompt.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 3)
  if (words.length === 0) return null
  return `🎨 ${words.join(' ')}`.slice(0, 60)
}
