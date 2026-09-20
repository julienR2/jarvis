/**
 * Seed data for a throwaway instance — the `next` stack, and the e2e run.
 *
 * Runs at boot on an empty database when SEED_FIXTURES=1. Everything it creates
 * is there to exercise a renderer or a page without talking to the engine:
 * markdown, an activity bubble with collapsed steps, a background run marker,
 * an app in the side pane, crons, webhooks, two runs parked on a question, an
 * API key.
 *
 * `rearm` (POST /internal/fixtures) puts the fixtures back in place WITHOUT
 * touching anything else: only the rows the fixtures own — fixed ids, listed
 * below — are deleted and re-inserted. The person's own chats, the sections
 * they moved things into, the e2e account and its password all stay. This is
 * what the e2e run does before it starts; a full wipe (POST /internal/reset)
 * is a separate, deliberate act.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import bcrypt from 'bcrypt'
import { getDb, uuid } from './db.js'
import { config } from './config.js'
import { generateApiKey, hashApiKey, keyHint } from './api-keys.js'
import { emitGlobalEvent } from './sse.js'

const MARKER_SECTION = '🧪 Fixtures'

export function seedFixtures(opts: { rearm?: boolean } = {}): void {
  const db = getDb()
  const present = !!db.prepare('SELECT 1 FROM sections WHERE name = ?').get(MARKER_SECTION)
  if (present && !opts.rearm) return
  const admin = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined
  if (!admin) {
    console.warn('[fixtures] no user yet — set ADMIN_EMAIL/ADMIN_PASSWORD so one exists at boot')
    return
  }

  // Fixed ids, so a preview pane or a spec can deep-link to a fixture
  // conversation and the link survives every reseed.
  const ID = {
    markdown: '00000000-0000-4000-8000-000000000001',
    activity: '00000000-0000-4000-8000-000000000002',
    brief: '00000000-0000-4000-8000-000000000003',
    app: '00000000-0000-4000-8000-000000000004',
    question: '00000000-0000-4000-8000-000000000005',
    approval: '00000000-0000-4000-8000-000000000006',
    chatAsk: '00000000-0000-4000-8000-000000000007',
  }

  const now = Math.floor(Date.now() / 1000)
  const t = (minutesAgo: number) => now - minutesAgo * 60

  // Everything below with a fixed id is fixture-owned and replaced on rearm.
  const cronId = '00000000-0000-4000-8000-0000000000c1'
  const yearlyId = '00000000-0000-4000-8000-0000000000c2'
  const askCronId = '00000000-0000-4000-8000-0000000000c3'
  const hookId = '00000000-0000-4000-8000-0000000000a1'
  const okHookId = '00000000-0000-4000-8000-0000000000a2'

  // Sections are reused by name: a rearm must not move the person's chats out
  // of a section they filed them under.
  const sections = [MARKER_SECTION, '☀️ Daily', '🏗️ Projects'].map((name, i) => {
    const row = db.prepare('SELECT id FROM sections WHERE name = ?').get(name) as { id: string } | undefined
    return { id: row?.id ?? uuid(), name, position: i, exists: !!row }
  })
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
    if (present) {
      // Conversations cascade to their messages and runs; crons and webhooks
      // only lose their link, so they go by id too.
      for (const id of Object.values(ID)) db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
      for (const id of [cronId, yearlyId, askCronId]) db.prepare('DELETE FROM crons WHERE id = ?').run(id)
      for (const id of [hookId, okHookId]) db.prepare('DELETE FROM webhooks WHERE id = ?').run(id)
    }
    for (const s of sections) if (!s.exists) insSection.run(s.id, s.name, s.position)
    const [fixtures, daily, projects] = sections
    // Projects is a topic: it carries a brief that every chat under it starts
    // from. Rewritten on every rearm so a hand-edit on next does not stick.
    db.prepare('UPDATE sections SET context = ?, context_updated_at = ? WHERE id = ?').run([
      '**What this is** — side projects and the tooling around them: the fixture app, the blog, whatever is being built this month.',
      '',
      '**Decided**',
      '- The blog publishes from the `publish-post` webhook; a push to main goes live.',
      '- Apps live in the side pane, one per chat.',
      '',
      '**Open**',
      '- Trip idea: beach or city still undecided.',
      '',
      '**How to work here**',
      '- Use the `apps` skill for anything with a UI; keep drafts under the drive.',
    ].join('\n'), t(60 * 24), projects.id)

    // 1. Markdown — every construct the bubble renders.
    const md = ID.markdown
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
    const act = ID.activity
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
    const bg = ID.brief
    insConv.run(bg, '🗞️ Morning brief', t(120), t(60), daily.id, null, null)
    // The run points at its cron, as a real one does — that link is what the
    // card's gear follows.
    const runId = uuid()
    db.prepare(
      'INSERT INTO runs (id, kind, source_id, source_name, conversation_id, run_key, inherit_context, status, started_at, ended_at, result) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
    ).run(runId, 'cron', cronId, 'morning-brief', bg, `cron-${runId}`, 'done', t(62), t(60), 'Brief posted')
    const stamp = JSON.stringify({ run_id: runId, isolated: true })
    insMsg.run(uuid(), bg, 'user', 'Write the morning brief.', stamp, null, null, t(62))
    insMsg.run(uuid(), bg, 'assistant', '[note:1] Weather first, then the todo list.\n\n[tool:1] curl wttr.in/Parede', stamp, 'activity',
      '☀️ 22°, light offshore until 10h. Three todos due today, nothing urgent in the inbox.', t(61))
    insMsg.run(uuid(), bg, 'user', 'Thanks — anything for tomorrow?', null, null, null, t(30))
    insMsg.run(uuid(), bg, 'assistant', 'Court booking opens at 9:15, and the gallery sync runs tonight.', null, null, null, t(29))

    // 4. An app in the side pane.
    const appConv = ID.app
    const appDir = join(config.workspaceDir, 'apps', 'fixture')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(join(appDir, 'index.html'), FIXTURE_APP_HTML)
    insConv.run(appConv, '◫ Fixture app', t(90), t(85), projects.id, 'apps/fixture', randomBytes(18).toString('base64url'))
    insMsg.run(uuid(), appConv, 'user', 'Build me a tiny app.', null, null, null, t(90))
    insMsg.run(uuid(), appConv, 'assistant', 'Done — it is in the preview pane.', null, null, null, t(86))

    // 5. Routines and a key — rows for the settings pages. The cron is disabled so
    // nothing in a throwaway instance ever fires.
    db.prepare('INSERT INTO crons (id, name, schedule, prompt, conversation_id, enabled) VALUES (?, ?, ?, ?, ?, 0)')
      .run(cronId, 'morning-brief', '30 5 * * *', 'Write the morning brief.', bg)
    db.prepare('INSERT INTO webhooks (id, name, token, prompt, conversation_id, enabled) VALUES (?, ?, ?, ?, ?, 1)')
      .run(hookId, 'fixture-hook', randomBytes(24).toString('base64url'), 'Handle the payload.', act)

    // 6. More run shapes for the Activity page — none of these wrote messages,
    // so they add rows to the log without adding cards to a chat.
    const insRun = db.prepare(
      'INSERT INTO runs (id, kind, source_id, source_name, conversation_id, run_key, inherit_context, status, started_at, ended_at, result, error, quiet) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
    )
    // yesterday's brief failed
    insRun.run(uuid(), 'cron', cronId, 'morning-brief', bg, `cron-${cronId}-y`, 'error', t(60 * 24 + 62), t(60 * 24 + 61), null,
      'PocketBase returned 401 while reading the transactions collection — token expired?', 0)
    // the hook handled something three hours ago — and said so in the chat
    const hookRunId = uuid()
    insRun.run(hookRunId, 'webhook', hookId, 'fixture-hook', act, `hook-${hookId}-1`, 'done', t(180), t(179),
      'Filed under Projects. One attachment, saved to the drive.', null, 0)
    const hookStamp = JSON.stringify({ run_id: hookRunId, isolated: true })
    insMsg.run(uuid(), act, 'user', 'Handle the payload.', hookStamp, null, null, t(180))
    insMsg.run(uuid(), act, 'assistant', '[note:1] An invoice from the school, so it goes under Projects.\n\n[tool:1] Bash: curl copyparty/projects/', hookStamp, 'activity',
      '**Filed under Projects.** One attachment — the school invoice, 48 € — saved to the drive.', t(179))
    // Three more fires since that had nothing to report — the newsletter case.
    // Quiet runs still write their messages; the chat folds them into one line.
    const skips: [number, string][] = [
      [50, '| Action | From | Subject |\n|---|---|---|\n| ⏭️ Skipped | JavaScript Weekly | Issue 703 |'],
      [35, '| Action | From | Subject |\n|---|---|---|\n| ⏭️ Skipped | GOG.com | Your order is complete |'],
      [20, 'RAS — a "sign in with Google" notice, nothing to do.'],
    ]
    for (const [ago, result] of skips) {
      const id = uuid()
      insRun.run(id, 'webhook', hookId, 'fixture-hook', act, `hook-${hookId}-q${ago}`, 'done', t(ago), t(ago) + 6, result, null, 1)
      const stamp = JSON.stringify({ run_id: id, isolated: true })
      insMsg.run(uuid(), act, 'user', 'Handle the payload.', stamp, null, null, t(ago))
      insMsg.run(uuid(), act, 'assistant', '[tool:1] Read skills/email-processor/SKILL.md', stamp, 'activity', result, t(ago) + 0)
    }
    // and a brief from two days ago, for the day grouping
    insRun.run(uuid(), 'cron', cronId, 'morning-brief', bg, `cron-${cronId}-2d`, 'done', t(60 * 48 + 62), t(60 * 48 + 60),
      'Overcast, no surf. Two todos due.', null, 0)
    // 7. A cron that IS enabled, so Today's "Coming up" has a row — scheduled
    // once a year, on New Year's night, so a throwaway instance all but never
    // fires it. Its run this morning failed and nothing succeeded since: that
    // is what "Needs you" lists. It belongs to the app conversation, so the
    // row offers "Open app".
    db.prepare('INSERT INTO crons (id, name, schedule, prompt, conversation_id, enabled) VALUES (?, ?, ?, ?, ?, 1)')
      .run(yearlyId, 'new-year-wish', '0 4 1 1 *', 'Wish the user a happy new year.', appConv)
    insRun.run(uuid(), 'cron', yearlyId, 'new-year-wish', appConv, `cron-${yearlyId}-t`, 'error', t(45), t(44), null,
      'The greetings API answered 503 three times — gave up.', 0)
    // 8. Two runs parked on the person — what "Needs you" is for. Their turns are
    // still in flight (no result on the last assistant message), the run is
    // `needs_you`, and the conversation carries the question. Neither has a
    // live engine session behind it, so an answer on this instance drops the
    // question and closes the run as lost — which is the honest outcome, and
    // what the spec that answers one checks.
    //
    // A question asked on purpose (AskUserQuestion) from a weekday cron…
    const askConv = ID.question
    insConv.run(askConv, '✉️ Reply to Marta', t(15), t(12), daily.id, null, null)
    db.prepare('INSERT INTO crons (id, name, schedule, prompt, conversation_id, enabled) VALUES (?, ?, ?, ?, ?, 0)')
      .run(askCronId, 'reply-marta', '0 9 * * 1-5', "Draft a reply to Marta's last email and ask me before sending.", askConv)
    const askRunId = uuid()
    const askKey = `cron-${askCronId}-w`
    insRun.run(askRunId, 'cron', askCronId, 'reply-marta', askConv, askKey, 'needs_you', t(12), null, null, null, 0)
    const askStamp = JSON.stringify({ run_id: askRunId, isolated: true })
    insMsg.run(uuid(), askConv, 'user', "Draft a reply to Marta's last email and ask me before sending.", askStamp, null, null, t(12))
    insMsg.run(uuid(), askConv, 'assistant', [
      "[note:1] Reading Marta's email, then drafting a reply in her tone.",
      '[tool:1] python3 gmail_search.py from:marta newer_than:7d',
      '[chunk:1] Draft ready:\n\n> Bonjour Marta, merci pour ton message — mardi 15h me convient très bien. À très vite !',
      '[note:2] Waiting for you: Send this reply to Marta?',
    ].join('\n\n'), askStamp, null, null, t(11))
    db.prepare('UPDATE conversations SET pending_question = ? WHERE id = ?').run(JSON.stringify({
      request_id: 'req_fixture_marta',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_fixture_marta',
      session_key: askKey,
      run_id: askRunId,
      asked_at: t(11),
      input: {
        questions: [{
          header: 'Send',
          question: 'Send this reply to Marta?',
          multiSelect: false,
          options: [
            { label: 'Send it', description: 'Send the draft as written' },
            { label: 'Edit first', description: 'Show me the draft so I can change it' },
          ],
        }],
      },
    }), askConv)

    // …and a tool call the permission rules escalated, from a webhook.
    const okConv = ID.approval
    insConv.run(okConv, '📝 Blog publish', t(40), t(6), projects.id, null, null)
    db.prepare('INSERT INTO webhooks (id, name, token, prompt, conversation_id, enabled) VALUES (?, ?, ?, ?, ?, 1)')
      .run(okHookId, 'publish-post', randomBytes(24).toString('base64url'), 'Publish the draft named in the payload.', okConv)
    const okRunId = uuid()
    const okKey = `hook-${okHookId}-w`
    insRun.run(okRunId, 'webhook', okHookId, 'publish-post', okConv, okKey, 'needs_you', t(6), null, null, null, 0)
    const okStamp = JSON.stringify({ run_id: okRunId, isolated: true })
    insMsg.run(uuid(), okConv, 'user', 'Publish the draft named in the payload.', okStamp, null, null, t(6))
    insMsg.run(uuid(), okConv, 'assistant', [
      '[note:1] The draft builds cleanly; pushing it publishes the site.',
      '[tool:1] npm run build',
      '[note:2] Waiting for you: Approve Bash: Push the post to the live site',
    ].join('\n\n'), okStamp, null, null, t(5))
    db.prepare('UPDATE conversations SET pending_question = ? WHERE id = ?').run(JSON.stringify({
      request_id: 'req_fixture_publish',
      tool_name: 'Bash',
      tool_use_id: 'toolu_fixture_publish',
      session_key: okKey,
      run_id: okRunId,
      asked_at: t(5),
      input: { command: 'git push origin main', description: 'Push the post to the live site' },
    }), okConv)

    // 9. A question asked in an ordinary chat — no cron, no webhook, so no run
    // behind it. Its turn is parked (last assistant message has no result) and
    // the conversation carries the pending question with run_id null. This is
    // what Today must surface even though the runs feed knows nothing about it.
    const chatConv = ID.chatAsk
    insConv.run(chatConv, '🧭 Trip idea', t(8), t(6), projects.id, null, null)
    insMsg.run(uuid(), chatConv, 'user', 'Help me plan a weekend somewhere warm.', null, null, null, t(8))
    insMsg.run(uuid(), chatConv, 'assistant', [
      '[note:1] A weekend, warm, from Lisbon — I should pin down the vibe before I dig.',
      '[note:2] Waiting for you: Beach or city for this trip?',
    ].join('\n\n'), null, null, null, t(7))
    db.prepare('UPDATE conversations SET pending_question = ? WHERE id = ?').run(JSON.stringify({
      request_id: 'req_fixture_trip',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_fixture_trip',
      session_key: chatConv,
      run_id: null,
      asked_at: t(7),
      input: {
        questions: [{
          header: 'Trip',
          question: 'Beach or city for this trip?',
          multiSelect: false,
          options: [
            { label: 'Beach', description: 'Sun, sea and not much of a plan' },
            { label: 'City', description: 'Museums, food, a walkable centre' },
          ],
        }],
      },
    }), chatConv)

    // Keys are per account, and the e2e account is what the checks sign in as:
    // every user here gets one, or the page reads "No API keys yet" to them.
    // Kept across rearms — a key is not a fixture row anyone mutates.
    const users = db.prepare('SELECT id FROM users').all() as { id: number }[]
    const insKey = db.prepare('INSERT INTO api_keys (id, user_id, name, key_hash, prefix) VALUES (?, ?, ?, ?, ?)')
    for (const u of users) {
      if (db.prepare('SELECT 1 FROM api_keys WHERE user_id = ? AND name = ?').get(u.id, 'fixture key')) continue
      const key = generateApiKey()
      insKey.run(uuid(), u.id, 'fixture key', hashApiKey(key), keyHint(key))
    }
  })
  tx()
  console.log(`[fixtures] ${present ? 'rearmed' : 'seeded'}: 3 sections, 7 conversations, 3 crons, 2 webhooks, 7 runs (2 waiting) + 1 chat question, 1 api key per user, 1 e2e user`)
  // Screens already open on this instance refetch what changed.
  if (present) emitGlobalEvent({ type: 'runs', conversation_id: ID.brief })
}

const FIXTURE_APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture app</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#faf9f7;color:#1a1816}
main{text-align:center}h1{font-weight:600;font-size:20px;margin:0 0 6px}p{color:#9b9590;margin:0}</style></head>
<body><main><h1>Fixture app</h1><p data-testid="fixture-app">Rendered in the side pane.</p></main></body></html>
`
