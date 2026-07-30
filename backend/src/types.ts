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
  last_read_at: number
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
  last_run: number | null
  last_result: string | null
  created_at: number
}

export interface UserRow {
  id: number
  email: string
  password_hash: string
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
