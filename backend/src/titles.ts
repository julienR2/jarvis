import { invokeAndWait } from './engine.js'

// Ask Claude for a short title for the conversation. Runs as a separate
// invocation against the existing session (so Claude has context) but does not
// show up in the conversation message history — we call the engine
// with a fresh conversationId so any concurrency/running state stays isolated
// from the main thread.

/**
 * Whether a returned string is plausibly a title rather than an error.
 *
 * The CLI reports some API failures on stdout and exits cleanly, so an error
 * can arrive here looking like a successful result — which is how a
 * conversation ended up titled "API Error: 400 diagnostics.previous_message_id
 * ...". Anything long, multi-line, or announcing itself as an error is not the
 * three-to-five words that were asked for.
 */
function looksLikeTitle(raw: string): boolean {
  if (!raw || raw.length > 80 || raw.includes('\n')) return false
  return !/^(api\s+error|error|401|403|404|429|5\d\d)\b/i.test(raw.trim())
}

export async function generateTitle(
  sessionId: string,
  conversationId: string,
  model?: string | null,
): Promise<string> {
  try {
    const raw = await invokeAndWait({
      prompt:
        'En 3 a 5 mots, quel est le sujet principal de cette conversation ? Reponds UNIQUEMENT avec le titre, sans ponctuation, sans guillemets, sans explication.',
      sessionId,
      conversationId: `title-${conversationId}`,
      // The conversation's own model, so this runs on the provider that owns
      // the session being resumed. Without it the title ran on the default
      // route, and resuming an OpenRouter session under Anthropic credentials
      // fails: the prior message id isn't one Anthropic issued.
      model: model ?? undefined,
    })
    const cleaned = raw.trim().replace(/^["'«]|["'».,]$/g, '')
    return looksLikeTitle(cleaned) ? cleaned : new Date().toLocaleString('fr-FR')
  } catch {
    return new Date().toLocaleString('fr-FR')
  }
}
