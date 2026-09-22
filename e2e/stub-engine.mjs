/**
 * A stand-in for the engine, for the duration of an e2e run.
 *
 * The suite is UI-only: it never sends a message and so never needs a `claude`
 * process. But several pages still ask the backend something the backend can
 * only answer by asking the engine — the plugins list behind Settings →
 * Advanced, "is this conversation running", deciding a parked approval. With no
 * engine there, the backend answers 502 and the console guard fails the test
 * for a reason that has nothing to do with the page.
 *
 * So: the smallest server that says "nothing is running, nothing is installed".
 * Plain node, no dependencies, no state. Anything not listed gets `{ok: true}`
 * and a line on stderr — if a spec starts depending on a real engine answer,
 * that line in results is where it shows up.
 */
import { createServer } from 'http'

const PORT = Number(process.env.PORT || 3110)

// [path, body, status]. Each answer is the truth about a server that holds no
// sessions — which is what the specs assert on: denying a seeded approval finds
// no session to deliver it to, and the UI says the run is no longer waiting.
const ROUTES = [
  [/^\/plugins$/, { marketplaces: [], installed: [], available: [] }, 200],
  [/^\/running\//, { running: false }, 200],
  [/^\/status$/, { invocations: [], sessions: [], conversations: [] }, 200],
  [/^\/answer\//, { error: 'no session holds this prompt' }, 404],
]

createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const match = ROUTES.find(([re]) => re.test(path))
  if (!match) console.error(`[stub-engine] unhandled ${req.method} ${path} → {ok:true}`)
  const [, body, status] = match ?? [null, { ok: true }, 200]
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}).listen(PORT, '127.0.0.1', () => console.log(`[stub-engine] :${PORT}`))
