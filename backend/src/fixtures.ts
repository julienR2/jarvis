/**
 * Seed data for a throwaway instance — the `next` stack, and later the e2e run.
 *
 * Runs once, on an empty database, when SEED_FIXTURES=1. Everything it creates
 * is there to exercise a renderer or a page without talking to the engine:
 * markdown, an activity bubble with collapsed steps, a background run marker,
 * an app in the side pane, a disabled cron, a webhook, an API key. The `reset`
 * flow (POST /internal/reset) wipes the DB and lets this run again, so "reseed"
 * and "fixtures for tests" are the same code path.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import bcrypt from 'bcrypt'
import { getDb, uuid } from './db.js'
import { config } from './config.js'
import { generateApiKey, hashApiKey, keyHint } from './api-keys.js'

const MARKER_SECTION = '🧪 Fixtures'

export function seedFixtures(): void {
  const db = getDb()
  if (db.prepare('SELECT 1 FROM sections WHERE name = ?').get(MARKER_SECTION)) return
  const admin = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined
  if (!admin) {
    console.warn('[fixtures] no user yet — set ADMIN_EMAIL/ADMIN_PASSWORD so one exists at boot')
    return
  }

  const now = Math.floor(Date.now() / 1000)
  const t = (minutesAgo: number) => now - minutesAgo * 60

  const sections = [MARKER_SECTION, '☀️ Daily', '🏗️ Projects'].map((name, i) => ({ id: uuid(), name, position: i }))
  const insSection = db.prepare('INSERT INTO sections (id, name, position) VALUES (?, ?, ?)')
  const insConv = db.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at, section_id, app_path, app_token) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const insMsg = db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, metadata, type, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )

  // A second account for automated checks, so the agent can log in to this
  // instance without ever holding the owner's password. The password is random
  // per seed and lands in a file only the containers can read — never a fixed
  // string: this instance sits behind the same public URL as prod, and the
  // engine behind it mounts the whole repo.
  const e2eEmail = 'e2e@jarvis.local'
  const e2ePassword = randomBytes(18).toString('base64url')
  if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get(e2eEmail)) {
    db.prepare('INSERT INTO users (email, password_hash, onboarded) VALUES (?, ?, 1)')
      .run(e2eEmail, bcrypt.hashSync(e2ePassword, 10))
    const credsPath = join(dirname(config.dbPath), 'e2e-credentials.json')
    writeFileSync(credsPath, JSON.stringify({ email: e2eEmail, password: e2ePassword }) + '\n', { mode: 0o600 })
    console.log(`[fixtures] e2e user ${e2eEmail}, credentials in ${credsPath}`)
  }

  // A throwaway instance is for looking at, not for being welcomed to: every
  // account here — the admin created at boot included — skips onboarding.
  db.prepare('UPDATE users SET onboarded = 1').run()

  const tx = db.transaction(() => {
    for (const s of sections) insSection.run(s.id, s.name, s.position)
    const [fixtures, daily, projects] = sections

    // 1. Markdown — every construct the bubble renders.
    const md = uuid()
    insConv.run(md, 'Markdown showcase', t(300), t(290), fixtures.id, null, null)
    insMsg.run(uuid(), md, 'user', 'Show me what you can render.', null, null, null, t(300))
    insMsg.run(uuid(), md, 'assistant', [
      '## Headings, lists, code',
      '',
      'A paragraph with **bold**, _italic_, `inline code` and a [link](https://example.com).',
      '',
      '- one',
      '- two',
      '  - nested',
      '',
      '1. first',
      '2. second',
      '',
      '| col | value |',
      '|---|---|',
      '| a | 1 |',
      '| b | 2 |',
      '',
      '```ts',
      'const answer = 42',
      '```',
      '',
      '> a quote, to close.',
    ].join('\n'), null, null, null, t(299))

    // 2. Activity — notes and tool calls folded between prose, a final result.
    const act = uuid()
    insConv.run(act, 'Activity steps', t(200), t(190), fixtures.id, null, null)
    insMsg.run(uuid(), act, 'user', 'How many photos did the school send this week?', null, null, null, t(200))
    insMsg.run(uuid(), act, 'assistant', [
      '[note:1] I need the gallery folder for this week, then a count per day.',
      '[tool:1] ls /workspace/gallery/2026-09',
      '[tool:1] python3 count.py --since monday',
      '[note:2] Twelve files, but two are duplicates by hash — dropping those.',
      '[tool:2] python3 dedupe.py',
      '[chunk:2] Counting is done, writing the answer.',
    ].join('\n\n'), null, 'activity', 'The school sent **10 photos** this week: 4 on Monday, 6 on Wednesday.', t(199))

    // 3. Background run — a cron that ran isolated, its output stamped with the run.
    const bg = uuid()
    insConv.run(bg, '🗞️ Morning brief', t(120), t(60), daily.id, null, null)
    const runId = uuid()
    db.prepare(
      'INSERT INTO runs (id, kind, source_id, source_name, conversation_id, run_key, inherit_context, status, started_at, ended_at, result) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
    ).run(runId, 'cron', null, 'morning-brief', bg, `cron-${runId}`, 'done', t(62), t(60), 'Brief posted')
    const stamp = JSON.stringify({ run_id: runId, isolated: true })
    insMsg.run(uuid(), bg, 'user', 'Write the morning brief.', stamp, null, null, t(62))
    insMsg.run(uuid(), bg, 'assistant', '[note:1] Weather first, then the todo list.\n\n[tool:1] curl wttr.in/Parede', stamp, 'activity',
      '☀️ 22°, light offshore until 10h. Three todos due today, nothing urgent in the inbox.', t(61))
    insMsg.run(uuid(), bg, 'user', 'Thanks — anything for tomorrow?', null, null, null, t(30))
    insMsg.run(uuid(), bg, 'assistant', 'Court booking opens at 9:15, and the gallery sync runs tonight.', null, null, null, t(29))

    // 4. An app in the side pane.
    const appConv = uuid()
    const appDir = join(config.workspaceDir, 'apps', 'fixture')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'index.html'), FIXTURE_APP_HTML)
    insConv.run(appConv, '◫ Fixture app', t(90), t(85), projects.id, 'apps/fixture', randomBytes(18).toString('base64url'))
    insMsg.run(uuid(), appConv, 'user', 'Build me a tiny app.', null, null, null, t(90))
    insMsg.run(uuid(), appConv, 'assistant', 'Done — it is in the preview pane.', null, null, null, t(86))

    // 5. Routines and a key — rows for the settings pages. The cron is disabled so
    // nothing in a throwaway instance ever fires.
    db.prepare('INSERT INTO crons (id, name, schedule, prompt, conversation_id, enabled) VALUES (?, ?, ?, ?, ?, 0)')
      .run(uuid(), 'morning-brief', '30 5 * * *', 'Write the morning brief.', bg)
    db.prepare('INSERT INTO webhooks (id, name, token, prompt, conversation_id, enabled) VALUES (?, ?, ?, ?, ?, 1)')
      .run(uuid(), 'fixture-hook', randomBytes(24).toString('base64url'), 'Handle the payload.', act)
    const key = generateApiKey()
    db.prepare('INSERT INTO api_keys (id, user_id, name, key_hash, prefix) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), admin.id, 'fixture key', hashApiKey(key), keyHint(key))
  })
  tx()
  console.log('[fixtures] seeded: 3 sections, 4 conversations, 1 run, 1 cron, 1 webhook, 1 api key, 1 e2e user')
}

const FIXTURE_APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture app</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#faf9f7;color:#1a1816}
main{text-align:center}h1{font-weight:600;font-size:20px;margin:0 0 6px}p{color:#9b9590;margin:0}</style></head>
<body><main><h1>Fixture app</h1><p data-testid="fixture-app">Rendered in the side pane.</p></main></body></html>
`
