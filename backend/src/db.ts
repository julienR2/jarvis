import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { config } from './config.js'

let db: Database.Database

export function getDb(): Database.Database {
  return db
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
  `)

  // Migration: add mini_app_path to conversations
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN mini_app_path TEXT DEFAULT NULL`)
  } catch {
    // Column already exists
  }

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

  // Migration: add last_read_at to conversations for unread tracking
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN last_read_at INTEGER`)
    db.exec(`UPDATE conversations SET last_read_at = updated_at WHERE last_read_at IS NULL`)
  } catch {
    // Column already exists
  }

  // Migration: add notify column to conversations (subscribe | unsubscribe | auto)
  try {
    db.exec(`ALTER TABLE conversations ADD COLUMN notify TEXT NOT NULL DEFAULT 'subscribe'`)
  } catch {
    // Column already exists
  }
}

export function uuid(): string {
  return randomUUID()
}
