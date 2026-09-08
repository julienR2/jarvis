// Gives a few of the seeded conversations real content, by actually asking the
// agent. Runs on the HOST against the demo's published port.
//
//   node demo/record/content.mjs
//
// Slow and separate from seed.mjs on purpose: these are real agent turns, they
// cost real tokens, and they only need redoing when you want different answers
// on screen. seed.mjs is instant and safe to re-run.
//
// Real turns rather than rows written straight into the database: the whole
// claim of the GIF is that this is the product working, and a hand-written
// transcript would be a picture of something that never ran.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API = process.env.DEMO_API ?? `http://127.0.0.1:${process.env.DEMO_BACKEND_PORT ?? 3105}`

const env = (k) => {
  const line = readFileSync(join(REPO, 'demo', '.env'), 'utf8')
    .split('\n').find((l) => l.startsWith(`${k}=`))
  if (!line) throw new Error(`${k} missing from demo/.env`)
  return line.slice(k.length + 1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let token
async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

/**
 * call(), but tolerant of the connection simply going away for a moment.
 *
 * These turns are polled for minutes at a time, and anything that restarts the
 * backend underneath — editing compose, `docker compose up`, tsx reloading on a
 * source change — turns one poll into `fetch failed` and used to abandon a turn
 * that was still running perfectly well on the server.
 */
async function callRetry(method, path, body, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await call(method, path, body)
    } catch (err) {
      const transient = err instanceof TypeError || /fetch failed|ECONNREFUSED|socket hang up/i.test(err.message)
      if (!transient || i >= tries) throw err
      await sleep(3000 * i)
    }
  }
}

// Which seeded conversation gets which prompt. Titles must match seed.mjs.
const TURNS = [
  {
    title: 'Neural networks, explained',
    // Produces the split view: the answer on the left, the app it built on the
    // right. That pairing is the single most Jarvis-specific thing to film.
    //
    // Two prompts, not one: building an app is a long tool-heavy turn, and the
    // bottom of that transcript — which is what a screenshot of a scrolled
    // conversation shows — is build commentary. The second prompt ends the
    // conversation on a written answer instead.
    prompts: [
      'Build me a small interactive app that shows how a neural network learns — something I can click and watch adjust.',
      'In a few short paragraphs, explain what I am looking at in the panel — no code, just the idea.',
    ],
  },
  {
    // A second app, deliberately more everyday than the neural network one:
    // "it built me a working tool" reads faster than "it built me a teaching
    // toy". open-meteo is named in the prompt because it needs no API key —
    // otherwise the agent reaches for a service the demo has no credential for
    // and spends the turn explaining that.
    title: 'Weather for the week',
    prompts: [
      'Build me a small weather app for the week ahead in Lisbon — use the open-meteo API, it needs no key. Make it something I would actually keep open.',
    ],
  },
  {
    // Image generation via the shipped `media` skill, which calls OpenRouter's
    // /v1/images. Needs a gateway key configured (Settings → Connection); with
    // none, the skill correctly refuses and this conversation is just a note
    // saying so.
    title: 'Pixel art desert island',
    prompts: [
      'Make me a pixel art picture of a desert island — palm tree, little beach, sunset behind it.',
    ],
  },
  {
    title: 'Server health check',
    // A visible tool-use turn: steps, then a written answer over real output.
    prompts: [
      'Check how this machine is doing — disk, memory, and anything running that looks unhealthy. Give me a short readable summary, not raw output.',
    ],
  },
]



/** Wait until a turn has actually finished, not merely started. */
async function waitForTurn(id, timeoutMs = 15 * 60_000) {
  const started = Date.now()
  let lastCount = -1
  let stable = 0
  while (Date.now() - started < timeoutMs) {
    await sleep(5000)
    const conv = await callRetry('GET', `/api/conversations/${id}`)
    const msgs = conv.messages ?? []

    // Done when the LAST message is a finished assistant turn. Checking "some
    // message has a result" would return immediately on a second prompt, since
    // the previous turn's result is still sitting in the transcript. Requiring
    // the count to hold still as well keeps it from stopping between two tool
    // steps of the turn currently running.
    const last = msgs[msgs.length - 1]
    const done = last?.role === 'assistant' && last.result != null
    stable = msgs.length === lastCount ? stable + 1 : 0
    lastCount = msgs.length
    if (done && stable >= 2) return
  }
  throw new Error(`turn in ${id} did not finish in time`)
}

async function main() {
  token = (await call('POST', '/api/auth/login', {
    email: env('ADMIN_EMAIL'), password: env('ADMIN_PASSWORD'),
  })).token

  const convs = await call('GET', '/api/conversations')

  // --only <substring> limits the run to matching conversations, for redoing
  // one that came out badly without paying for the others again.
  const onlyIdx = process.argv.indexOf('--only')
  const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1]?.toLowerCase()
  const force = process.argv.includes('--force')

  for (const { title, prompts } of TURNS) {
    if (only && !title.toLowerCase().includes(only)) continue

    const conv = convs.find((c) => c.title === title)
    if (!conv) throw new Error(`no conversation titled "${title}" — run seed.mjs first`)

    // Idempotent: a conversation that already has messages is left alone, so a
    // re-run after one turn failed costs only the turn that is actually
    // missing. --force sends the prompts again regardless.
    const existing = await callRetry('GET', `/api/conversations/${conv.id}`)
    if ((existing.messages ?? []).length && !force) {
      console.log(`  ${title} … already has content, skipping`)
      continue
    }

    for (const [i, content] of prompts.entries()) {
      process.stdout.write(`  ${title} [${i + 1}/${prompts.length}] … `)
      await callRetry('POST', `/api/conversations/${conv.id}/messages`, { content })
      await waitForTurn(conv.id)
      console.log('done')
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
