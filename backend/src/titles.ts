import { invokeAndWait } from './session-manager.js'

// Ask Claude for a short title for the conversation. Runs as a separate
// invocation against the existing session (so Claude has context) but does not
// show up in the conversation message history — we call the session-manager
// with a fresh conversationId so any concurrency/running state stays isolated
// from the main thread.
export async function generateTitle(
  sessionId: string,
  conversationId: string,
): Promise<string> {
  try {
    const raw = await invokeAndWait({
      prompt:
        'En 3 a 5 mots, quel est le sujet principal de cette conversation ? Reponds UNIQUEMENT avec le titre, sans ponctuation, sans guillemets, sans explication.',
      sessionId,
      conversationId: `title-${conversationId}`,
    })
    return (
      raw.trim().replace(/^["'«]|["'».,]$/g, '') ||
      new Date().toLocaleString('fr-FR')
    )
  } catch {
    return new Date().toLocaleString('fr-FR')
  }
}
