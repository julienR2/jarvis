import { createContext, useContext } from 'react'

/**
 * Opens a file beside the chat, as a tab of the side pane. Provided by the
 * chat view; absent where there is no side pane (a share link, a thread shown
 * inside another chat), and then file links simply open in a new browser tab.
 */
export const PanelOpenerContext = createContext<((path: string) => void) | null>(null)
export const usePanelOpener = () => useContext(PanelOpenerContext)

/** What a document tab can show — the backend's list, by extension. */
const OPENABLE = /\.(md|markdown|txt|log|csv|json|ya?ml|html?|pdf)$/i

/**
 * The file a link points at, as an absolute path, when it is one the side pane
 * can show: a path under /jarvis (as the agent writes them), or an uploads URL
 * (as the chat serves them). Anything else — the web, an image — is not ours.
 */
export function openablePath(href: string | undefined): string | null {
  if (!href) return null
  const path = href.split(/[?#]/)[0]
  const uploads = path.match(/\/api\/uploads\/files\/(.+)$/)
  const abs = uploads ? `/jarvis/agent/workspace/uploads/${decodeURIComponent(uploads[1])}` : path
  if (!abs.startsWith('/jarvis/') || !OPENABLE.test(abs)) return null
  try { return decodeURI(abs) } catch { return abs }
}
