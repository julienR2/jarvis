// Fills the demo instance with the content the tour films: sections, chats,
// crons, webhooks and connectors. Runs on the HOST against the demo's
// published port — no browser involved.
//
//   node demo/record/seed.mjs            # add what's missing
//   node demo/record/seed.mjs --prune    # ...and drop what is no longer listed
//   node demo/record/seed.mjs --fresh    # delete everything first, then seed
//
// Everything here is invented and generic. The demo has its own database, so
// nothing personal is in scope to leak — but the point of a public GIF is that
// every pixel is meant to be looked at, so the content is written to be read.
//
// Conversations are created WITH a title. Titles are otherwise auto-generated
// by backend/src/titles.ts, whose prompt is French; passing one up front skips
// that path (it only fires on the literal title "New conversation"), which is
// what keeps an English take English.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const API = process.env.DEMO_API ?? `http://127.0.0.1:${process.env.DEMO_BACKEND_PORT ?? 3105}`
const FRESH = process.argv.includes('--fresh')

const env = (k) => {
  const line = readFileSync(join(REPO, 'demo', '.env'), 'utf8')
    .split('\n').find((l) => l.startsWith(`${k}=`))
  if (!line) throw new Error(`${k} missing from demo/.env — run: bash demo/demo.sh seed`)
  return line.slice(k.length + 1)
}

let token
async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      // Only when there is actually a body: Fastify rejects a bodyless request
      // that still declares application/json with a 400, which is what every
      // DELETE here is.
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

// ── Content ─────────────────────────────────────────────────────────────────

// Emoji in the names because that is how these lists actually look in use —
// a wall of same-length grey strings reads as filler in a screenshot, and the
// glyph is what the eye lands on first.
const SECTIONS = ['💼 Work', '🏡 Home']

// Titles only — these populate the sidebar. The conversations that are read on
// screen get real content further down.
const CHATS = [
  { title: '📋 Weekly team digest', section: '💼 Work' },
  { title: '🧾 Invoice follow-ups', section: '💼 Work' },
  { title: '🚀 Release notes draft', section: '💼 Work' },
  { title: '🏝️ Trip planning — Lisbon', section: '🏡 Home' },
  { title: '🔖 Bookmarks to sort', section: '🏡 Home' },
  { title: '🛒 Groceries', section: '🏡 Home' },
  // Loose chats stay unadorned, which is what gives the sectioned ones above
  // their visual weight. These are also the ones content.mjs fills in, so they
  // are the titles that appear in the chat and app screenshots.
  { title: 'Server health check' },
  { title: 'Neural networks, explained' },
  { title: 'Weather for the week' },
  { title: 'Pixel art desert island' },
]

const CRONS = [
  {
    name: 'morning-brief', schedule: '30 6 * * *',
    prompt: 'Summarise anything that arrived overnight — mail, issues, alerts. Lead with what actually needs me. Keep it to a screen.',
  },
  {
    name: 'weekly-digest', schedule: '0 9 * * 1',
    prompt: 'Pull together what shipped last week from the repo and the issue tracker, and post the digest into this conversation.',
  },
  {
    name: 'link-cleanup', schedule: '0 3 * * 0', enabled: false,
    prompt: 'Walk the saved bookmarks, drop the dead links, and group whatever is left by topic.',
  },
]

const WEBHOOKS = [
  { name: 'deploy-finished', prompt: 'A deploy just finished. Check the health endpoint, and tell me only if something looks wrong.' },
  { name: 'new-issue', prompt: 'A new issue was filed. Triage it: summarise, guess a severity, and suggest a label.' },
]

// Values are placeholders — the demo has no real credentials and needs none.
// What the page shows is that a connector is configured, not what is in it.
const CONNECTORS = [
  { id: 'gmail', name: 'Gmail', icon: 'Mail', description: 'Send and read email', fields: [['Address', 'demo@example.com', 'email'], ['App password', 'placeholder']] },
  { id: 'github', name: 'GitHub', icon: 'Github', description: 'Push code and manage repositories', fields: [['Token', 'placeholder']] },
  { id: 'linear', name: 'Linear', icon: 'SquareKanban', description: 'Track issues and projects', fields: [['API key', 'placeholder']] },
  { id: 'slack', name: 'Slack', icon: 'MessageSquare', description: 'Send and read messages as yourself', fields: [['Bot token', 'placeholder']] },
  { id: 'elevenlabs', name: 'ElevenLabs', icon: 'AudioLines', description: 'Speech-to-text and voices', fields: [['API key', 'placeholder']] },
  { id: 'drive', name: 'Drive', icon: 'HardDrive', description: 'Browse and manage files on personal storage', fields: [['Password', 'placeholder']] },
  { id: 'pocketbase', name: 'PocketBase', icon: 'Database', description: 'Read and write application records', fields: [['Password', 'placeholder']] },
  { id: 'imagerouter', name: 'ImageRouter', icon: 'Image', description: 'Generate images and video', fields: [['API key', 'placeholder']] },
]

// The official Claude Code plugin marketplace, so the Plugins page has
// something real in it rather than an empty state.
const MARKETPLACE = 'anthropics/claude-code'

// ── Seeding ─────────────────────────────────────────────────────────────────

async function wipe() {
  for (const path of ['/api/conversations', '/api/crons', '/api/webhooks', '/api/sections']) {
    const rows = await call('GET', path)
    const list = Array.isArray(rows) ? rows : rows?.items ?? []
    for (const row of list) await call('DELETE', `${path}/${row.id}`)

    // Verify rather than assume. A half-finished wipe leaves one stale row in
    // the sidebar of every shot taken afterwards, and swallowing the error is
    // exactly how that goes unnoticed until you are looking at the GIF.
    const left = await call('GET', path)
    const remaining = (Array.isArray(left) ? left : left?.items ?? []).length
    if (remaining) throw new Error(`${path} still has ${remaining} row(s) after wipe`)
  }
  // 404 here just means the connector was never seeded — that one is fine to skip.
  for (const c of CONNECTORS) {
    await call('DELETE', `/api/connectors/${c.id}`).catch((e) => {
      if (!/→ 404/.test(e.message)) throw e
    })
  }
  console.log('  wiped existing content')
}

/**
 * Drop seeded rows that are no longer in the lists above — what you want after
 * renaming something here, which otherwise leaves the old copy sitting next to
 * the new one.
 *
 * Conversations with messages are never touched, whatever their title: those
 * are content.mjs's real agent turns, they cost real tokens, and silently
 * deleting one to tidy a list would be the worst thing this script could do.
 */
async function prune() {
  const wantChats = new Set(CHATS.map((c) => c.title))
  for (const conv of await call('GET', '/api/conversations')) {
    if (wantChats.has(conv.title)) continue

    // A cron that fires during a session opens its own conversation. Those are
    // machine-generated, and in a demo with no real mail or issue tracker they
    // are a paragraph explaining there was nothing to read — so they go,
    // content or not. Everything else with messages is protected below.
    if (/^Cron: /.test(conv.title) || /^Webhook: /.test(conv.title)) {
      await call('DELETE', `/api/conversations/${conv.id}`)
      console.log(`  pruned scheduled-run conversation "${conv.title}"`)
      continue
    }

    const full = await call('GET', `/api/conversations/${conv.id}`)
    if ((full.messages ?? []).length) {
      console.log(`  keeping "${conv.title}" — unlisted but has content`)
      continue
    }
    await call('DELETE', `/api/conversations/${conv.id}`)
    console.log(`  pruned conversation "${conv.title}"`)
  }

  const wantSections = new Set(SECTIONS)
  for (const sec of await call('GET', '/api/sections')) {
    if (wantSections.has(sec.name)) continue
    await call('DELETE', `/api/sections/${sec.id}`)
    console.log(`  pruned section "${sec.name}"`)
  }

  const wantCrons = new Set(CRONS.map((c) => c.name))
  for (const c of await call('GET', '/api/crons')) {
    if (!wantCrons.has(c.name)) { await call('DELETE', `/api/crons/${c.id}`); console.log(`  pruned cron "${c.name}"`) }
  }
  const wantHooks = new Set(WEBHOOKS.map((w) => w.name))
  for (const w of await call('GET', '/api/webhooks')) {
    if (!wantHooks.has(w.name)) { await call('DELETE', `/api/webhooks/${w.id}`); console.log(`  pruned webhook "${w.name}"`) }
  }
}

async function main() {
  token = (await call('POST', '/api/auth/login', {
    email: env('ADMIN_EMAIL'), password: env('ADMIN_PASSWORD'),
  })).token

  if (FRESH) await wipe()
  if (process.argv.includes('--prune')) await prune()

  // Everything below adds only what is missing, matched on name/title, so a
  // re-run without --fresh tops the instance up instead of doubling it —
  // which is what you want after adding one new item to the lists above, or
  // after content.mjs has spent real tokens on conversations worth keeping.
  const existing = async (path, key) => {
    const rows = await call('GET', path)
    return new Set((Array.isArray(rows) ? rows : rows?.items ?? []).map((r) => r[key]))
  }

  const haveSections = await existing('/api/sections', 'name')
  const sections = {}
  for (const row of await call('GET', '/api/sections')) sections[row.name] = row.id
  let added = 0
  for (const name of SECTIONS) {
    if (haveSections.has(name)) continue
    sections[name] = (await call('POST', '/api/sections', { name })).id
    added++
  }
  console.log(`  ${added}/${SECTIONS.length} sections added`)

  const haveChats = await existing('/api/conversations', 'title')
  added = 0
  for (const { title, section } of CHATS) {
    if (haveChats.has(title)) continue
    const conv = await call('POST', '/api/conversations', { title })
    if (section) await call('PATCH', `/api/conversations/${conv.id}`, { section_id: sections[section] })
    added++
  }
  console.log(`  ${added}/${CHATS.length} conversations added`)

  const haveCrons = await existing('/api/crons', 'name')
  added = 0
  for (const c of CRONS) {
    if (haveCrons.has(c.name)) continue
    await call('POST', '/api/crons', c); added++
  }
  console.log(`  ${added}/${CRONS.length} crons added`)

  const haveHooks = await existing('/api/webhooks', 'name')
  added = 0
  for (const w of WEBHOOKS) {
    if (haveHooks.has(w.name)) continue
    await call('POST', '/api/webhooks', w); added++
  }
  console.log(`  ${added}/${WEBHOOKS.length} webhooks added`)

  const haveConnectors = await existing('/api/connectors', 'id')
  added = 0
  for (const c of CONNECTORS) {
    if (haveConnectors.has(c.id)) continue
    await call('POST', '/api/connectors', {
      id: c.id, name: c.name, icon: c.icon, description: c.description,
      fields: c.fields.map(([label, value, type]) => ({ label, value, type: type ?? 'password' })),
    })
    added++
  }
  console.log(`  ${added}/${CONNECTORS.length} connectors added`)

  // Gives the Plugins page a catalogue to show. This one shells out to the
  // `claude` binary in the engine container and hits the network, so it is the
  // slow step here and the only one allowed to fail without taking the seed
  // down — an offline box should still get a populated sidebar.
  try {
    const state = await call('GET', '/api/plugins')
    const names = (state?.marketplaces ?? []).map((m) => m.name ?? m.source ?? '')
    if (names.some((n) => String(n).includes(MARKETPLACE.split('/')[1]))) {
      console.log(`  marketplace ${MARKETPLACE} already added`)
    } else {
      await call('POST', '/api/plugins/marketplaces', { source: MARKETPLACE })
      console.log(`  marketplace ${MARKETPLACE} added`)
    }
  } catch (e) {
    console.log(`  marketplace ${MARKETPLACE} skipped (${e.message.split('\n')[0]})`)
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
