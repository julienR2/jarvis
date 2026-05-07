export interface ConvRow {
  id: string
  title: string
  claude_session_id: string | null
  mini_app_path: string | null
  notify: 'subscribe' | 'unsubscribe' | 'auto'
  model: string | null
  thinking: number
  last_read_at: number
  created_at: number
  updated_at: number
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
  thinking: number
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
  thinking: number
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
  secrets_json: string
  connected_at: number
  updated_at: number
}
