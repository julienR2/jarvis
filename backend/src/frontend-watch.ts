import { watch, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { emitGlobalEvent } from './sse.js'

// Watch the built frontend and tell open tabs when a new build lands.
//
// Jarvis edits its own frontend, but the container runs `vite build --watch`
// behind `vite preview` — a production build, not a dev server. There is no HMR
// and no websocket to the browser, so a self-edit is invisible until someone
// reloads by hand. Without this the agent says "I've updated the interface"
// and the user keeps staring at the old one.
//
// index.html is the signal: every build rewrites it with fresh hashed asset
// URLs, so its content changing means there is genuinely something new to load.

const DIST_INDEX = join(
  process.env.JARVIS_REPO_DIR || '/jarvis',
  'frontend/dist/index.html',
)

// A build rewrites the file in several steps; wait for it to settle so tabs are
// told once, and only once the new assets are actually on disk.
const SETTLE_MS = 1500

export function startFrontendWatch(): void {
  if (!existsSync(DIST_INDEX)) {
    console.log(`[frontend-watch] ${DIST_INDEX} not found, skipping`)
    return
  }

  let lastContent = ''
  try { lastContent = readFileSync(DIST_INDEX, 'utf8') } catch { /* read on next tick */ }

  let timer: NodeJS.Timeout | null = null

  const check = () => {
    let content: string
    try {
      content = readFileSync(DIST_INDEX, 'utf8')
    } catch {
      return // mid-write; the next event brings us back
    }
    if (!content || content === lastContent) return
    lastContent = content
    console.log('[frontend-watch] new build detected, notifying clients')
    emitGlobalEvent({ type: 'frontend_updated' })
  }

  try {
    watch(DIST_INDEX, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(check, SETTLE_MS)
    })
    console.log(`[frontend-watch] watching ${DIST_INDEX}`)
  } catch (err) {
    console.error('[frontend-watch] could not watch:', err)
  }
}
