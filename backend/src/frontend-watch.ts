import { watch, readFileSync, existsSync, type FSWatcher } from 'fs'
import { dirname, join } from 'path'
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
const DIST_DIR = dirname(DIST_INDEX)

// A build rewrites the file in several steps; wait for it to settle so tabs are
// told once, and only once the new assets are actually on disk.
const SETTLE_MS = 1500

// How long to wait before looking for dist again, when it isn't there yet or
// the watch dropped out from under us.
const REARM_MS = 5000

export function startFrontendWatch(): void {
  let lastContent = ''
  try { lastContent = readFileSync(DIST_INDEX, 'utf8') } catch { /* read on first event */ }

  let timer: NodeJS.Timeout | null = null
  let watcher: FSWatcher | null = null

  const check = () => {
    let content: string
    try {
      content = readFileSync(DIST_INDEX, 'utf8')
    } catch {
      return // mid-write, or dist is being replaced; the next event brings us back
    }
    if (!content || content === lastContent) return
    lastContent = content
    console.log('[frontend-watch] new build detected, notifying clients')
    emitGlobalEvent({ type: 'frontend_updated' })
  }

  // Watch the *directory*, not index.html itself. A file watch is bound to the
  // inode it was opened on, so anything that replaces index.html rather than
  // rewriting it in place — `vite build` emptying outDir, most notably — leaves
  // a live watcher attached to a file nobody will ever write again. It fails
  // silently: no error, no events, and the reload banner simply stops working
  // until the backend restarts.
  const arm = () => {
    if (!existsSync(DIST_DIR)) {
      // No dist yet (a fresh checkout that hasn't built). Keep looking instead
      // of giving up for the lifetime of the process.
      setTimeout(arm, REARM_MS)
      return
    }

    try {
      watcher = watch(DIST_DIR, (_event, filename) => {
        // Every asset write lands here; index.html is the only one that matters.
        // filename can be null on some platforms — fall through and check.
        if (filename && filename !== 'index.html') return
        if (timer) clearTimeout(timer)
        timer = setTimeout(check, SETTLE_MS)
      })

      // If the directory itself goes away, re-establish rather than going deaf.
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        setTimeout(arm, REARM_MS)
      })

      console.log(`[frontend-watch] watching ${DIST_DIR}`)
    } catch (err) {
      console.error('[frontend-watch] could not watch, retrying:', err)
      setTimeout(arm, REARM_MS)
    }
  }

  arm()
}
