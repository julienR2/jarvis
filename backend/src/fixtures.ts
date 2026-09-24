/**
 * Seed data for a throwaway instance — the stack `e2e/run.sh` starts.
 *
 * Runs at boot on an empty database when SEED_FIXTURES=1. Everything it creates
 * is there to exercise a renderer or a page without talking to the engine:
 * markdown, an activity bubble with collapsed steps, a background run marker,
 * an app in the side pane, crons, webhooks, two runs parked on a question, an
 * API key.
 *
 * Nothing here re-arms or cleans up: the e2e run gets a database created
 * seconds earlier and deleted when it ends, so a fresh picture costs a rerun.
 * Prod never sets SEED_FIXTURES and so never reaches any of this.
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
    app2: '00000000-0000-4000-8000-000000000008',
    unread: '00000000-0000-4000-8000-000000000009',
    quoted: '00000000-0000-4000-8000-00000000000a',
    // Today's inbox: chats no other spec opens, so their read state holds
    // whatever order the workers run in.
    inboxNotified: '00000000-0000-4000-8000-00000000000b',
    inboxUnread: '00000000-0000-4000-8000-00000000000c',
    inboxToRead: '00000000-0000-4000-8000-00000000000d',
    // Deleted by the delete-dialog spec: nothing else may rely on it.
    scratch: '00000000-0000-4000-8000-00000000000e',
  }

  const now = Math.floor(Date.now() / 1000)
  const t = (minutesAgo: number) => now - minutesAgo * 60

  // Everything below with a fixed id is fixture-owned.
  const cronId = '00000000-0000-4000-8000-0000000000c1'
  const yearlyId = '00000000-0000-4000-8000-0000000000c2'
  const askCronId = '00000000-0000-4000-8000-0000000000c3'
  const hookId = '00000000-0000-4000-8000-0000000000a1'
  const okHookId = '00000000-0000-4000-8000-0000000000a2'

  // Sections are looked up by name before being created, so a database that
  // already has one keeps it rather than ending up with two.
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
    for (const s of sections) if (!s.exists) insSection.run(s.id, s.name, s.position)
    const [fixtures, daily, projects] = sections
    // Projects is a topic: it carries a brief that every chat under it starts
    // from.
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
    // Fixtures carries a LONG brief, the one that folds behind "Show more" on
    // its page. Its own topic so the spec editing Projects' brief can't shorten
    // it from under the fold test (workers run in parallel).
    db.prepare('UPDATE sections SET context = ?, context_updated_at = ? WHERE id = ?').run([
      '**What this is** — the seeded data every check runs against: a conversation per rendering case, three routines, a couple of runs waiting on an answer.',
      '',
      '**Decided**',
      '- Fixed ids (`00000000-0000-4000-8000-00000000000N`) so a spec can deep-link and survive a reseed.',
      '- Seeded into a database that is created and deleted per run, never into a real one.',
      '- Named by what they exercise, not by what they contain.',
      '',
      '**Open**',
      '- A running-run fixture is impossible: the boot reconcile marks it interrupted.',
      '- Whether the quiet-run fold deserves its own conversation.',
      '',
      '**How to work here**',
      '- Add a row in `backend/src/fixtures.ts` when a page needs data, with a fixed id.',
      '- Count by name in specs, never the whole table.',
      '- Every run starts from a database created seconds earlier; nothing to reset.',
      '',
      '**History**',
      '- Week 36: markdown, activity and brief conversations; the first app.',
      '- Week 37: the two waiting runs and the chat question; the API key per user.',
      '- Week 38: the second app, the unread thread, the quoted reply.',
    ].join('\n'), t(60 * 24 * 2), fixtures.id)
    // Fixture groups start as topics-to-be, never hidden.
    db.prepare('UPDATE sections SET brief_hidden = 0 WHERE id IN (?, ?, ?)').run(fixtures.id, daily.id, projects.id)

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

    // 2b. A long thread read half-way: the last three answers are unread, so
    // the chat opens at the divider and the arrow's badge starts at 3.
    const un = ID.unread
    insConv.run(un, 'Unread thread', t(400), t(60), fixtures.id, null, null)
    const para = (n: number) =>
      `Point ${n}: ` +
      'a paragraph long enough to fill some screen, because the divider only means something when there is history above it to scroll through. '.repeat(3)
    // Stored like a real finished answer: the transcript in `content`, the
    // answer in `result` — the unread count only sees rows with a result.
    for (let n = 1; n <= 6; n++) {
      insMsg.run(uuid(), un, 'user', `Question ${n}?`, null, null, null, t(400 - n * 50))
      insMsg.run(uuid(), un, 'assistant', `[chunk:1] ${para(n)}`, null, null, para(n), t(400 - n * 50 - 1))
    }
    // Read after answer 3 (at t(249)); answers 4–6 (t(199) and later) are
    // unread — the marker is set with the other read states at the end.

    // 2c. A reply to a passage: the user message carries `reply_to` and the
    // bubble shows the quote as a citation that leads back to its source.
    const qc = ID.quoted
    insConv.run(qc, 'Quoted reply', t(500), t(470), fixtures.id, null, null)
    insMsg.run(uuid(), qc, 'user', 'Which board for Guincho this week?', null, null, null, t(500))
    const quotedMsg = uuid()
    const boardAnswer = "A 6'2 shortboard if the swell holds through Thursday; otherwise the fish, which paddles better in the mush. Either way check the wind before noon."
    insMsg.run(quotedMsg, qc, 'assistant', `[chunk:1] ${boardAnswer}`, null, null, boardAnswer, t(499))
    insMsg.run(uuid(), qc, 'user', "Which fish do you mean, the 5'8?", JSON.stringify({ reply_to: { message_id: quotedMsg, text: 'otherwise the fish, which paddles better in the mush' } }), null, null, t(472))
    const twinMsg = uuid()
    insMsg.run(twinMsg, qc, 'assistant', "[chunk:1] The 5'8 twin, yes.", null, null, "The 5'8 twin, yes.", t(471))
    // Each answer records its model; the follow-up was sent on another one, so
    // its bubble names it (a chat on one model shows no label at all).
    const setModel = db.prepare('UPDATE messages SET model = ? WHERE id = ?')
    setModel.run('claude-opus-5-5', quotedMsg)
    setModel.run('claude-haiku-4-5', twinMsg)

    // 2c'. A plain chat with no files and no routines — the delete dialog asks
    // it nothing beyond the delete itself.
    insConv.run(ID.scratch, 'Scratch', t(520), t(519), fixtures.id, null, null)
    insMsg.run(uuid(), ID.scratch, 'user', 'Remind me what a torque wrench is for.', null, null, null, t(520))
    insMsg.run(uuid(), ID.scratch, 'assistant', '[chunk:1] Tightening bolts to a set force.', null, null, 'Tightening bolts to a set force.', t(519))

    // 2d. Today's inbox, one chat per reason. Read states are set at the end.
    const answer = (conv: string, user: string, text: string, at: number) => {
      insMsg.run(uuid(), conv, 'user', user, null, null, null, at)
      insMsg.run(uuid(), conv, 'assistant', `[chunk:1] ${text}`, null, null, text, at + 30)
    }
    insConv.run(ID.inboxNotified, '📣 Gallery sync', t(700), t(35), fixtures.id, null, null)
    answer(ID.inboxNotified, 'Sync the gallery tonight and tell me how it went.', 'Gallery synced: 212 photos, 3 duplicates skipped, 41 s. Nothing failed.', t(36))
    insConv.run(ID.inboxUnread, '💬 Pasta water', t(800), t(50), fixtures.id, null, null)
    answer(ID.inboxUnread, 'How salty should pasta water be?', 'About 1% — a tablespoon of salt per litre. Salt once it boils, not before.', t(400))
    answer(ID.inboxUnread, 'And how long for fresh tagliatelle?', 'Two to three minutes once it floats; taste one at two.', t(51))
    insConv.run(ID.inboxToRead, '💬 Bike tyre pressure', t(900), t(80), fixtures.id, null, null)
    answer(ID.inboxToRead, 'Gravel tyres, 40 mm, 75 kg rider — pressure?', 'Around 2.4 bar front and 2.6 rear; drop 0.2 on wet or loose ground.', t(81))

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
    // A second one, so switching from one app chat to another can be checked:
    // the pane has to show this app with its own token, not the previous one.
    const app2Dir = join(config.workspaceDir, 'apps', 'fixture-two')
    mkdirSync(app2Dir, { recursive: true })
    writeFileSync(join(app2Dir, 'index.html'), FIXTURE_APP_HTML.replace(/Fixture app/g, 'Second app').replace('fixture-app', 'fixture-app-two'))
    insConv.run(ID.app2, '◫ Second app', t(88), t(84), projects.id, 'apps/fixture-two', randomBytes(18).toString('base64url'))
    insMsg.run(uuid(), ID.app2, 'user', 'And another one.', null, null, null, t(88))
    insMsg.run(uuid(), ID.app2, 'assistant', 'Second app is up, in its own pane.', null, null, null, t(85))

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
    // Quiet runs still write their messages, stamped quiet; the chat shows none of it.
    const skips: [number, string][] = [
      [50, '| Action | From | Subject |\n|---|---|---|\n| ⏭️ Skipped | JavaScript Weekly | Issue 703 |'],
      [35, '| Action | From | Subject |\n|---|---|---|\n| ⏭️ Skipped | GOG.com | Your order is complete |'],
      [20, 'RAS — a "sign in with Google" notice, nothing to do.'],
    ]
    for (const [ago, result] of skips) {
      const id = uuid()
      insRun.run(id, 'webhook', hookId, 'fixture-hook', act, `hook-${hookId}-q${ago}`, 'done', t(ago), t(ago) + 6, result, null, 1)
      const stamp = JSON.stringify({ run_id: id, isolated: true, quiet: true })
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
    const users = db.prepare('SELECT id FROM users').all() as { id: number }[]
    const insKey = db.prepare('INSERT INTO api_keys (id, user_id, name, key_hash, prefix) VALUES (?, ?, ?, ?, ?)')
    for (const u of users) {
      if (db.prepare('SELECT 1 FROM api_keys WHERE user_id = ? AND name = ?').get(u.id, 'fixture key')) continue
      const key = generateApiKey()
      insKey.run(uuid(), u.id, 'fixture key', hashApiKey(key), keyHint(key))
    }
  })
  tx()
  // Read state, for Today's inbox: most fixture chats are read; the unread
  // thread keeps its three new answers; the brief chat was worth a push
  // (notified, unread); the waiting chats are unread so their cards have the
  // question to show.
  db.prepare(
    `UPDATE conversations SET last_read_at = updated_at + 1, notified_at = NULL
      WHERE id IN (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ID.markdown, ID.activity, ID.app, ID.app2, ID.quoted, ID.unread, ID.scratch)
  db.prepare('UPDATE conversations SET last_read_at = ? WHERE id = ?').run(t(240), ID.unread)
  db.prepare('UPDATE conversations SET last_read_at = ?, notified_at = ? WHERE id = ?').run(t(120), t(61), ID.brief)
  // The inbox trio: notified (a push went out after it was last read), unread
  // with one exchange already read above the new one, unread to be marked read.
  db.prepare('UPDATE conversations SET last_read_at = ?, notified_at = ? WHERE id = ?').run(t(600), t(35), ID.inboxNotified)
  db.prepare('UPDATE conversations SET last_read_at = ?, notified_at = NULL WHERE id = ?').run(t(300), ID.inboxUnread)
  db.prepare('UPDATE conversations SET last_read_at = ?, notified_at = NULL WHERE id = ?').run(t(800), ID.inboxToRead)
  db.prepare('UPDATE conversations SET last_read_at = created_at - 1, notified_at = NULL WHERE id IN (?, ?, ?)').run(ID.question, ID.approval, ID.chatAsk)

  // Effort is a switch, off unless chosen; the columns' old default says 'high'.
  const ids = Object.values(ID)
  db.prepare(`UPDATE conversations SET effort = 'default' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
  db.prepare('UPDATE crons SET effort = ? WHERE id IN (?, ?, ?)').run('default', cronId, yearlyId, askCronId)
  db.prepare('UPDATE webhooks SET effort = ? WHERE id IN (?, ?)').run('default', hookId, okHookId)

  console.log('[fixtures] seeded: 3 sections, 13 conversations, 3 crons, 2 webhooks, 7 runs (2 waiting) + 1 chat question, 1 api key per user, 1 e2e user')
}

const FIXTURE_APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture app</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#faf9f7;color:#1a1816}
main{text-align:center}h1{font-weight:600;font-size:20px;margin:0 0 6px}p{color:#9b9590;margin:0}</style></head>
<body><main><h1>Fixture app</h1><p data-testid="fixture-app">Rendered in the side pane.</p></main></body></html>
`
