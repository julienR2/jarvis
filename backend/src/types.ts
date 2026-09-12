export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ConvRow {
  id: string
  title: string
  claude_session_id: string | null
  app_path: string | null
  notify: 'subscribe' | 'unsubscribe' | 'auto'
  model: string | null
  effort: EffortLevel
  section_id: string | null
  context_tokens: number | null
  context_window: number | null
  last_read_at: number
  /** Capability granted by the share link; null when the chat isn't shared. */
  share_mode: 'read' | 'write' | null
  share_token: string | null
  app_token: string | null
  created_at: number
  updated_at: number
}

export interface SectionRow {
  id: string
  name: string
  position: number
  created_at: number
}

export interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  type: 'activity' | 'error' | null
  content: string
  result: string | null
  metadata: string | null
  created_at: number
  /** SQLite rowid — strict insertion order, used as the pagination cursor. */
  seq: number
}

export interface CronRow {
  id: string
  name: string
  schedule: string
  prompt: string
  conversation_id: string | null
  enabled: number
  once: number
  model: string | null
  effort: EffortLevel
  /** 0 = run in a throwaway session, reporting into the linked conversation. */
  inherit_context: number
  last_run: number | null
  last_result: string | null
  created_at: number
}

export interface WebhookRow {
  id: string
  name: string
  token: string
  prompt: string
  conversation_id: string | null
  enabled: number
  model: string | null
  effort: EffortLevel
  notify: 'auto' | 'never' | 'always'
  user_message_key: string | null
  /** 0 = run in a throwaway session, reporting into the linked conversation. */
  inherit_context: number
  last_run: number | null
  last_result: string | null
  created_at: number
}

export type RunKind = 'cron' | 'webhook'

/** Terminal states a run can reach. `interrupted` = lost, not cancelled. */
export type RunStatus = 'running' | 'done' | 'error' | 'stopped' | 'interrupted'

export interface RunRow {
  id: string
  kind: RunKind
  /** The cron/webhook this came from. Kept after that row is deleted. */
  source_id: string | null
  source_name: string
  conversation_id: string
  /** Engine session key. NULL when the run used the conversation's own. */
  run_key: string | null
  inherit_context: number
  status: RunStatus
  started_at: number
  ended_at: number | null
  result: string | null
  error: string | null
}

export interface UserRow {
  id: number
  email: string
  password_hash: string
  created_at: number
}

export interface ApiKeyRow {
  id: string
  user_id: number
  name: string
  key_hash: string
  /** Opening characters of the key, for telling keys apart in the UI. */
  prefix: string
  last_used_at: number | null
  created_at: number
}

export interface ConnectorRow {
  id: string
  name: string
  description: string
  icon: string
  fields_json: string
  proxy_json: string | null
  created_at: number
  updated_at: number
}
