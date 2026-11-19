// Runs Playwright MCP against the headful Chromium and keeps that pairing
// usable. Mounted read-only into the browser-mcp container (see its comment in
// docker-compose.yml); the engine doesn't mount scripts/, so the agent can't
// edit what runs here.
//
// Two failure modes, neither of which the server notices on its own:
//
// 1. Chromium restarted, and this container is left in its dead network
//    namespace. DevTools stays unreachable; exit, and the restart policy
//    starts us again inside chromium's current namespace.
//
// 2. One tab stops answering: a hung renderer, or a JS dialog left open.
//    Playwright attaches to every page on connect and waits for each to
//    answer, so a single such tab makes every connection time out while
//    Chromium itself looks healthy. Close a tab that has stayed unresponsive
//    for a couple of minutes. A dialog can't be told apart from a hang here —
//    a fresh DevTools session only sees dialogs opened after it enabled the
//    Page domain — hence the long grace period before closing anything.

import { spawn } from 'node:child_process'

const DEVTOOLS = 'http://localhost:9222'
const HEALTH_EVERY_MS = 10_000
const HEALTH_MISSES_BEFORE_EXIT = 6 // ~1 min
const TABS_EVERY_MS = 30_000
const TAB_ANSWER_TIMEOUT_MS = 5_000
const TAB_MISSES_BEFORE_CLOSE = 4 // ~2 min

const log = (...args) => console.log('[watchdog]', ...args)

const server = spawn('node', ['/app/cli.js', ...process.argv.slice(2)], { stdio: 'inherit' })
server.on('exit', (code) => {
  log(`MCP server exited (${code}), exiting so the container restarts`)
  process.exit(1)
})
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.kill(signal)
    process.exit(0)
  })
}

async function devtools(path) {
  const res = await fetch(DEVTOOLS + path, { signal: AbortSignal.timeout(TAB_ANSWER_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res
}

let healthMisses = 0
setInterval(async () => {
  try {
    await devtools('/json/version')
    healthMisses = 0
  } catch {
    if (++healthMisses >= HEALTH_MISSES_BEFORE_EXIT) {
      log('Chromium DevTools unreachable for 60s, restarting to rejoin its network')
      server.kill()
      process.exit(1)
    }
  }
}, HEALTH_EVERY_MS)

// Does the page's renderer run a trivial script? Anything Playwright needs on
// attach goes through the same main thread, so this answers iff attach would.
function answers(wsUrl) {
  return new Promise((resolve) => {
    let ws
    const done = (ok) => {
      clearTimeout(timer)
      try { ws?.close() } catch {}
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), TAB_ANSWER_TIMEOUT_MS)
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      return done(true) // can't tell; don't count it against the tab
    }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '0' } }))
    ws.onmessage = (event) => {
      if (JSON.parse(event.data).id === 1) done(true)
    }
    ws.onerror = () => done(true) // connection-level trouble is the health check's job
  })
}

const tabMisses = new Map()
async function sweepTabs() {
  let pages
  try {
    pages = (await (await devtools('/json/list')).json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  } catch {
    return
  }
  const present = new Set(pages.map((p) => p.id))
  for (const id of tabMisses.keys()) if (!present.has(id)) tabMisses.delete(id)

  await Promise.all(pages.map(async (page) => {
    if (await answers(page.webSocketDebuggerUrl)) {
      tabMisses.delete(page.id)
      return
    }
    const misses = (tabMisses.get(page.id) ?? 0) + 1
    tabMisses.set(page.id, misses)
    if (misses < TAB_MISSES_BEFORE_CLOSE) return
    log(`closing tab unresponsive for ~${(misses * TABS_EVERY_MS) / 60_000} min: ${page.url.slice(0, 120)}`)
    tabMisses.delete(page.id)
    await devtools(`/json/close/${page.id}`).catch((err) => log(`close failed: ${err.message}`))
  }))
}

let sweeping = false
setInterval(async () => {
  if (sweeping) return
  sweeping = true
  try { await sweepTabs() } finally { sweeping = false }
}, TABS_EVERY_MS)
