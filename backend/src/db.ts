import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { config } from './config.js'
import type { EffortLevel } from './types.js'

let db: Database.Database

export function getDb(): Database.Database {
  return db
}

export const EFFORT_LEVELS: EffortLevel[] = ['default', 'high']

/** Effort is a switch: 'high' (and the old max/xhigh) mean think hard; anything else is the model's default. */
export function normalizeEffort(v: unknown): EffortLevel {
  return v === true || v === 'high' || v === 'max' || v === 'xhigh' ? 'high' : 'default'
}

export function initDb(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true })
  db = new Database(config.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New conversation',
      claude_session_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

    -- Sidebar groups. The catch-all "Chats" group is NOT a row here: it is
    -- conversations with section_id IS NULL, so it can never be renamed,
    -- deleted, or left in an inconsistent state.
    CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS crons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      prompt TEXT NOT NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      once INTEGER NOT NULL DEFAULT 0,
      last_run INTEGER,
      last_result TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      prompt TEXT NOT NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run INTEGER,
      last_result TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    -- Long-lived credentials for calling the same API the web UI calls.
    -- Only the SHA-256 of the key is stored, so a leaked database hands over
    -- no working key; the plaintext is shown once, at creation, and never again.
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      -- The opening characters, kept in clear so the UI can tell two keys
      -- apart without holding enough to reconstruct either.
      prefix TEXT NOT NULL,
      last_used_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `)

  // Migration: add app_path to conversations
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN mini_app_path TEXT DEFAULT NULL`)
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE conversations RENAME COLUMN mini_app_path TO app_path`)
  } catch { /* already renamed */ }

  // Migration: add type column to messages
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN type TEXT CHECK(type IN ('activity', 'error'))`)

    // Migrate existing activity messages: move type from metadata to column, steps to content
    const activityMsgs = db.prepare(
      `SELECT id, metadata FROM messages WHERE metadata LIKE '%"type":"activity"%'`,
    ).all() as { id: string; metadata: string }[]

    const updateStmt = db.prepare('UPDATE messages SET type = ?, content = ?, metadata = NULL WHERE id = ?')
    for (const msg of activityMsgs) {
      try {
        const parsed = JSON.parse(msg.metadata)
        if (parsed.type === 'activity') {
          const steps = (parsed.steps || []) as string[]
          updateStmt.run('activity', steps.join('\n'), msg.id)
        }
      } catch { /* skip malformed */ }
    }
  } catch {
    // Column already exists
  }

  // Migration: add result column to messages
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN result TEXT`)
  } catch {
    // Column already exists
  }

  // Migration: the model a message was sent with (user rows) or answered by
  // (assistant rows), and the effort it asked for. The model belongs to the
  // message, not the conversation: each message picks its own, and a routine
  // posting into a chat keeps its own model without touching the picker's.
  // NULL on rows written before this — which model ran them is unknown.
  for (const col of ['model', 'effort']) {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN ${col} TEXT`)
    } catch {
      // Column already exists
    }
  }

  // Migration: add last_read_at to conversations for unread tracking
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN last_read_at INTEGER`)
    db.exec(`UPDATE conversations SET last_read_at = updated_at WHERE last_read_at IS NULL`)
  } catch {
    // Column already exists
  }

  // Repair, every boot: a NULL last_read_at silently disables unread counting
  // for that conversation forever. `m.created_at > NULL` is NULL, not true, so
  // the COUNT matches nothing and the chat never shows a badge no matter how
  // many replies land. Conversations created by a webhook or a cron used to
  // land exactly that way — their INSERTs never set the column, and the
  // back-fill above only runs on the boot that adds it. Idempotent and cheap,
  // and worth doing unconditionally because the symptom is silence.
  db.exec(
    `UPDATE conversations
        SET last_read_at = COALESCE(updated_at, unixepoch())
      WHERE last_read_at IS NULL`,
  )

  // Migration: add notify column to conversations (subscribe | unsubscribe | auto)
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN notify TEXT NOT NULL DEFAULT 'subscribe'`)
  } catch {
    // Column already exists
  }

  // Migration: add model + thinking to conversations
  try {
    // No column default: NULL means "use the global default" (see backend/src/models.ts)
    db.exec(`ALTER TABLE conversations ADD COLUMN model TEXT`)
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN thinking INTEGER NOT NULL DEFAULT 0`)
  } catch { /* already exists */ }

  // Migration: context gauge. Persisted (rather than kept in the engine
  // session) because sessions are reaped after 15 min idle — without this, a
  // conversation would show no gauge until its next turn.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN context_tokens INTEGER`)
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN context_window INTEGER`)
  } catch { /* already exists */ }

  // Migration: add pinned to conversations
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`)
  } catch { /* already exists */ }

  // Migration: sections replace the pinned flag. Existing pins are folded into a
  // real "Pinned" section at the top of the sidebar; deleting a section drops its
  // conversations back into the default group via ON DELETE SET NULL. The legacy
  // `pinned` column is left in place (unused) so existing rows aren't disturbed.
  try {
    db.exec(
      `ALTER TABLE conversations ADD COLUMN section_id TEXT REFERENCES sections(id) ON DELETE SET NULL`,
    )
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM conversations WHERE pinned = 1')
      .get() as { n: number }
    if (n > 0) {
      const id = randomUUID()
      db.prepare('INSERT INTO sections (id, name, position) VALUES (?, ?, 0)').run(id, 'Pinned')
      db.prepare('UPDATE conversations SET section_id = ? WHERE pinned = 1').run(id)
    }
  } catch { /* already exists */ }

  // Migration: add model + thinking to crons
  try {
    db.exec(`ALTER TABLE crons ADD COLUMN model TEXT`)
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE crons ADD COLUMN thinking INTEGER NOT NULL DEFAULT 0`)
  } catch { /* already exists */ }
  // A cron that only fires when nothing else is running — a worker that must
  // not compete with a live chat or another routine for the engine.
  try {
    db.exec(`ALTER TABLE crons ADD COLUMN solo INTEGER NOT NULL DEFAULT 0`)
  } catch { /* already exists */ }

  // Migration: add model + thinking to webhooks
  try {
    db.exec(`ALTER TABLE webhooks ADD COLUMN model TEXT`)
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE webhooks ADD COLUMN thinking INTEGER NOT NULL DEFAULT 0`)
  } catch { /* already exists */ }

  // Migration: normalize the legacy model column default to the NULL marker.
  // Older DBs added the `model` column with DEFAULT 'claude-sonnet-4-6', so rows
  // created without an explicit model carry that stale id. NULL now means "use
  // the global default" (backend/src/models.ts → resolveModel), so rewrite the
  // legacy value; real user selections use current ids and are untouched.
  for (const table of ['conversations', 'crons', 'webhooks']) {
    db.exec(`UPDATE ${table} SET model = NULL WHERE model = 'claude-sonnet-4-6'`)
  }

  // Migration: replace the boolean `thinking` flag with a granular effort level
  // (low | medium | high | xhigh | max). Backfill preserves behaviour: the old
  // "extended thinking" ON state mapped to `--effort max`, everything else to
  // the model default `high`. The legacy `thinking` column is left in place
  // (unused) so existing rows aren't disturbed.
  for (const table of ['conversations', 'crons', 'webhooks']) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN effort TEXT NOT NULL DEFAULT 'high'`)
      db.exec(`UPDATE ${table} SET effort = 'max' WHERE thinking = 1`)
    } catch { /* already exists */ }
  }

  // Migration (2026-09-21): effort becomes a switch — 'high' passes --effort
  // high, 'default' passes nothing — and starts off for everyone. The old
  // four-step levels were a default nobody chose, so every row is reset once.
  // user_version marks it done: a later 'high' picked by hand must survive boots.
  if ((db.pragma('user_version', { simple: true }) as number) < 1) {
    for (const table of ['conversations', 'crons', 'webhooks']) {
      db.exec(`UPDATE ${table} SET effort = 'default'`)
    }
    db.pragma('user_version = 1')
    console.log('[db] effort reset to the model default on every row (switch model)')
  }

  // Migration: add onboarded flag to users (existing users are considered already onboarded)
  try {
    db.exec(`ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0`)
  } catch { /* already exists */ }
  // Backfill: ensure any pre-onboarding users are marked as onboarded
  db.exec(`UPDATE users SET onboarded = 1 WHERE onboarded = 0 AND created_at < unixepoch() - 60`)

  // Migration: add notify + user_message_key to webhooks
  try {
    db.exec(`ALTER TABLE webhooks ADD COLUMN notify TEXT NOT NULL DEFAULT 'auto'`)
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE webhooks ADD COLUMN user_message_key TEXT DEFAULT NULL`)
  } catch { /* already exists */ }

  // Migration: per-conversation app share token.
  //
  // App URLs used to carry the user's own login JWT, which meant one token
  // opened every app AND handed whoever received the link a 30-day credential
  // for the whole API. This is a capability for exactly one app, revocable on
  // its own by rotating it.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN app_token TEXT DEFAULT NULL`)
  } catch { /* already exists */ }
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_app_token
       ON conversations(app_token) WHERE app_token IS NOT NULL`,
    )
  } catch { /* already exists */ }

  // Migration: conversation sharing.
  //
  // share_mode is the capability the link grants: 'read' shows the transcript,
  // 'write' also lets the visitor reply. NULL means not shared — the token is
  // kept across a disable/enable cycle only if the owner doesn't rotate it.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN share_token TEXT DEFAULT NULL`)
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN share_mode TEXT DEFAULT NULL`)
  } catch { /* already exists */ }
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_share_token
       ON conversations(share_token) WHERE share_token IS NOT NULL`,
    )
  } catch { /* already exists */ }

  // Migration: isolated runs for crons and webhooks.
  //
  // A scheduled run doesn't need — and shouldn't pay for — the whole history of
  // the conversation it reports into. With inherit_context = 0 (the default) a
  // run gets its own throwaway Claude session and only its *output* lands in the
  // linked conversation. That conversation's own session is left untouched, so
  // chatting there afterwards still resumes the context the human built.
  //
  // Existing rows default to 0 too, deliberately: these prompts are already
  // self-contained, and the ones that had grown a 500k-token history were
  // re-reading (and paying for) all of it on every single fire.
  for (const table of ['crons', 'webhooks']) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN inherit_context INTEGER NOT NULL DEFAULT 0`)
    } catch { /* already exists */ }
  }

  // Runs — one row per cron/webhook fire.
  //
  // Before this table an isolated run existed only as an entry in an in-memory
  // map keyed by a throwaway `cron-…`/`hook-…` string. Nothing outside the
  // backend process knew it was there, which is why it could not be stopped
  // (Stop cancels the *conversation's* engine session, and an isolated run is
  // not in it), why a refresh dropped the spinner while the run carried on, and
  // why a restart lost it entirely. `run_key` is that string, now persisted: it
  // is what the engine answers to. NULL means the run inherited the
  // conversation's own session, so the conversation id is the key.
  //
  // source_id has no foreign key on purpose: deleting a cron must not erase the
  // history of what it did, and source_name is denormalised for the same reason.
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('cron', 'webhook')),
      source_id TEXT,
      source_name TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_key TEXT,
      inherit_context INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('running', 'needs_you', 'done', 'error', 'stopped', 'interrupted')),
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at INTEGER,
      result TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_conv ON runs(conversation_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_running ON runs(status) WHERE status IN ('running', 'needs_you');
  `)

  // Migration: `needs_you` joined the run statuses. SQLite cannot alter a CHECK
  // constraint in place, so a table created before it is rebuilt — same
  // columns, copied across, indexes recreated. Detected from the stored DDL.
  const runsDdl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'`).get() as { sql: string } | undefined)?.sql ?? ''
  if (!runsDdl.includes('needs_you')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE runs_v2 (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('cron', 'webhook')),
          source_id TEXT,
          source_name TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          run_key TEXT,
          inherit_context INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('running', 'needs_you', 'done', 'error', 'stopped', 'interrupted')),
          started_at INTEGER NOT NULL DEFAULT (unixepoch()),
          ended_at INTEGER,
          result TEXT,
          error TEXT
        );
        INSERT INTO runs_v2 (id, kind, source_id, source_name, conversation_id, run_key, inherit_context, status, started_at, ended_at, result, error)
          SELECT id, kind, source_id, source_name, conversation_id, run_key, inherit_context, status, started_at, ended_at, result, error FROM runs;
        DROP TABLE runs;
        ALTER TABLE runs_v2 RENAME TO runs;
        CREATE INDEX IF NOT EXISTS idx_runs_conv ON runs(conversation_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_runs_running ON runs(status) WHERE status IN ('running', 'needs_you');
      `)
    })()
    console.log('[db] runs table rebuilt with the needs_you status')
  }

  // Migration: a run that had nothing to report. Set when the run closes (see
  // runs.ts isQuietResult) so the chat can fold a day's silent fires into one
  // line instead of one card each — most email triages end in "skipped".
  const runCols = (db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name)
  if (!runCols.includes('quiet')) {
    db.exec(`ALTER TABLE runs ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0`)
    console.log('[db] runs.quiet column added')
  }

  // Migration: what a conversation is waiting on (see PendingQuestion).
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN pending_question TEXT DEFAULT NULL`)
  } catch { /* already exists */ }

  // Migration: an inbox row that has been read. Today lists a finished run once
  // under "Worth telling you"; dismissing it (POST /api/runs/:id/dismiss) takes
  // it off the page without touching the chat it wrote into.
  if (!runCols.includes('dismissed')) {
    db.exec(`ALTER TABLE runs ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0`)
    console.log('[db] runs.dismissed column added')
  }

  // Migration: topics. A section is more than a sidebar group — it carries a
  // shared context (what the topic is, what was decided, what is open) that
  // every chat filed under it starts from. `context_updated_at` lets a warm
  // session learn about a rewrite; `topic_context_at` on the conversation is
  // when it last got the text (see topics.ts).
  try {
    db.exec(`ALTER TABLE sections ADD COLUMN context TEXT NOT NULL DEFAULT ''`)
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE sections ADD COLUMN context_updated_at INTEGER`)
  } catch { /* already exists */ }
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN topic_context_at INTEGER`)
  } catch { /* already exists */ }
  // A group that is a folder, not a topic: its brief is hidden on the page and
  // never handed to its chats, until someone brings it back.
  try {
    db.exec(`ALTER TABLE sections ADD COLUMN brief_hidden INTEGER NOT NULL DEFAULT 0`)
  } catch { /* already exists */ }
  // When a push last went out for the conversation. Today ranks a chat that
  // was worth a notification above one that merely has unread answers.
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN notified_at INTEGER`)
  } catch { /* already exists */ }

  // Connectors — one row per connector holding its definition AND its values.
  // Unified from the former three-way split (hardcoded catalog + custom_connectors
  // definitions + connectors secrets). See connectors.ts.
  migrateConnectors(db)
}

export function uuid(): string {
  return randomUUID()
}

// ── Connector migration ──────────────────────────────────────────────────────
// Seed definitions for the eight connectors that used to live in the hardcoded
// catalog. Used ONLY to reconstruct rows during the one-time migration — after
// that, connectors are plain DB rows with no code counterpart.
type SeedField = { key: string; label: string; type: string }
const CONNECTOR_SEED: Record<string, { name: string; description: string; icon: string; fields: SeedField[]; proxy?: unknown }> = {
  gmail: { name: 'Gmail', description: 'Send and read emails via Gmail', icon: 'Mail', fields: [
    { key: 'GMAIL_ADDRESS', label: 'Email address', type: 'email' },
    { key: 'GMAIL_APP_PASSWORD', label: 'App password', type: 'password' },
  ] },
  github: { name: 'GitHub', description: 'Push code and manage repositories', icon: 'Github', fields: [
    { key: 'GITHUB_TOKEN', label: 'Personal access token', type: 'password' },
  ] },
  linear: { name: 'Linear', description: 'Track issues and projects', icon: 'SquareKanban', fields: [
    { key: 'LINEAR_API_KEY', label: 'API key', type: 'password' },
  ] },
  slack: { name: 'Slack', description: 'Send and read messages as yourself', icon: 'MessageSquare', fields: [
    { key: 'SLACK_USER_TOKEN', label: 'User OAuth token', type: 'password' },
  ] },
  elevenlabs: { name: 'ElevenLabs', description: 'Speech-to-text + text-to-speech', icon: 'AudioLines', fields: [
    { key: 'ELEVENLABS_API_KEY', label: 'API key', type: 'password' },
  ] },
  pocketbase: { name: 'PocketBase', description: 'Self-hosted backend — collections, records, financial data', icon: 'Database', fields: [
    { key: 'POCKETBASE_URL', label: 'Base URL', type: 'text' },
    { key: 'POCKETBASE_EMAIL', label: 'Admin email', type: 'email' },
    { key: 'POCKETBASE_PASSWORD', label: 'Admin password', type: 'password' },
  ] },
  copyparty: { name: 'Copyparty', description: 'Personal file drive — browse, upload, and manage files', icon: 'HardDrive', fields: [
    { key: 'COPYPARTY_BASE_URL', label: 'Base URL', type: 'text' },
    { key: 'COPYPARTY_PASSWORD', label: 'Password', type: 'password' },
  ], proxy: { baseUrlField: 'COPYPARTY_BASE_URL', cookieField: { name: 'cppwd', valueField: 'COPYPARTY_PASSWORD' } } },
  imagerouter: { name: 'ImageRouter', description: 'Generate AI images (Flux, SDXL, DALL·E, Ideogram…)', icon: 'Image', fields: [
    { key: 'IMAGEROUTER_API_KEY', label: 'API key', type: 'password' },
  ] },
}

function migrateConnectors(db: Database.Database): void {
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE name='connectors'").get() as { sql?: string } | undefined
  // Legacy schemas: the very old one had `connector_id`; the previous one had
  // `secrets_json` but no `fields_json`. Both need folding into the new shape.
  const isLegacy = !!info && !info.sql?.includes('fields_json')

  if (isLegacy) {
    db.exec('DROP TABLE IF EXISTS connectors_legacy')
    db.exec('ALTER TABLE connectors RENAME TO connectors_legacy')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'Plug',
      fields_json TEXT NOT NULL DEFAULT '[]',
      proxy_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  if (!isLegacy) return

  const legacy = db.prepare('SELECT id, secrets_json, connected_at, updated_at FROM connectors_legacy').all() as
    Array<{ id: string; secrets_json: string; connected_at: number; updated_at: number }>

  const hasCustom = !!db.prepare("SELECT name FROM sqlite_master WHERE name='custom_connectors'").get()
  const customById = new Map<string, { id: string; name: string; description: string; icon: string; fields_json: string; created_at: number; updated_at: number }>()
  if (hasCustom) {
    for (const c of db.prepare('SELECT * FROM custom_connectors').all() as any[]) customById.set(c.id, c)
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO connectors (id, name, description, icon, fields_json, proxy_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  // Build fields from a definition, then append any saved secret keys the
  // definition didn't cover — custom-connector definitions can drift from the
  // keys actually saved, and we must never drop a real value.
  const buildFields = (defs: SeedField[], secrets: Record<string, string>) => {
    const used = new Set<string>()
    const out = defs.map((f) => {
      used.add(f.key)
      return { key: f.key, label: f.label, type: f.type || 'password', value: secrets[f.key] ?? '' }
    })
    for (const [k, v] of Object.entries(secrets)) {
      if (!used.has(k)) out.push({ key: k, label: k, type: 'password', value: v })
    }
    return out
  }

  const seen = new Set<string>()

  // 1. Every connector that had saved values (built-in seed or custom definition).
  for (const row of legacy) {
    let secrets: Record<string, string> = {}
    try { secrets = JSON.parse(row.secrets_json) } catch { /* */ }
    const seed = CONNECTOR_SEED[row.id]
    const custom = customById.get(row.id)

    let name: string, description: string, icon: string, fields: any[], proxy: unknown | undefined
    if (seed) {
      name = seed.name; description = seed.description; icon = seed.icon
      fields = buildFields(seed.fields, secrets); proxy = seed.proxy
    } else if (custom) {
      let defs: SeedField[] = []
      try { defs = JSON.parse(custom.fields_json) } catch { /* */ }
      name = custom.name; description = custom.description; icon = custom.icon
      fields = buildFields(defs, secrets); proxy = undefined
    } else {
      // Orphan secrets with no definition anywhere — synthesize from the keys.
      name = row.id; description = ''; icon = 'Plug'
      fields = Object.entries(secrets).map(([k, v]) => ({ key: k, label: k, type: 'password', value: v }))
      proxy = undefined
    }
    insert.run(row.id, name, description, icon, JSON.stringify(fields), proxy ? JSON.stringify(proxy) : null, row.connected_at, row.updated_at)
    seen.add(row.id)
  }

  // 2. Custom definitions that were never connected (no values row).
  for (const [id, custom] of customById) {
    if (seen.has(id)) continue
    let defs: SeedField[] = []
    try { defs = JSON.parse(custom.fields_json) } catch { /* */ }
    const fields = defs.map((f) => ({ key: f.key, label: f.label, type: f.type || 'password', value: '' }))
    insert.run(id, custom.name, custom.description, custom.icon, JSON.stringify(fields), null, custom.created_at, custom.updated_at)
  }

  db.exec('DROP TABLE connectors_legacy')
  if (hasCustom) db.exec('DROP TABLE custom_connectors')
}
