/** Think hard on ('high' → `--effort high`) or the model's own default (no flag). */
export type EffortLevel = 'default' | 'high'

export interface ConvRow {
  id: string
  title: string
  claude_session_id: string | null
  app_path: string | null
  notify: 'subscribe' | 'unsubscribe' | 'auto'
  model: string | null
  effort: EffortLevel
  /** Legacy column, unused: reasoning summaries were removed (2026-09-21). */
  thinking: number
  section_id: string | null
  context_tokens: number | null
  context_window: number | null
  last_read_at: number
  /** When a push last went out for this chat; Today ranks on it. */
  notified_at: number | null
  /** Capability granted by the share link; null when the chat isn't shared. */
  share_mode: 'read' | 'write' | null
  share_token: string | null
  app_token: string | null
  /** JSON of a PendingQuestion while Jarvis waits on the person; else NULL. */
  pending_question: string | null
  /** When the topic's context was last handed to this conversation's session. */
  topic_context_at: number | null
  created_at: number
  updated_at: number
}

/**
 * What a conversation is waiting on: a question Jarvis asked (AskUserQuestion,
 * `input.questions`) or a tool call its permission rules escalated (any other
 * tool_name, `input` = the call's arguments). One at a time per conversation;
 * the engine queues the rest.
 */
export interface PendingQuestion {
  request_id: string
  tool_name: string
  tool_use_id: string | null
  input: Record<string, unknown>
  /** Engine session key to answer on: the run's own key, or the conversation id. */
  session_key: string
  /** The run whose turn is parked, when a cron/webhook asked. */
  run_id: string | null
  asked_at: number
}

export interface SectionRow {
  id: string
  name: string
  position: number
  /** The topic's shared context, markdown. Empty for a plain group. */
  context: string
  context_updated_at: number | null
  /** 1 when the group is a plain folder: no brief shown, none given to its chats. */
  brief_hidden: number
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
  /** Legacy column, unused. */
  thinking: number
  /** 0 = run in a throwaway session, reporting into the linked conversation. */
  /** 1 = skip a fire while any run (any conversation) is still active. */
  solo: number
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
  /** Legacy column, unused. */
  thinking: number
  notify: 'auto' | 'never' | 'always'
  user_message_key: string | null
  /** 0 = run in a throwaway session, reporting into the linked conversation. */
  inherit_context: number
  last_run: number | null
  last_result: string | null
  created_at: number
}

export type RunKind = 'cron' | 'webhook'

/**
 * `running` and `needs_you` are the live states — the latter is a turn parked on
 * a question or approval, still stoppable, back to `running` once answered.
 * The rest are terminal; `interrupted` = lost, not cancelled.
 */
export type RunStatus = 'running' | 'needs_you' | 'done' | 'error' | 'stopped' | 'interrupted'

/** The states in which a run is still going and can be stopped. */
export const ACTIVE_RUN_STATUSES: RunStatus[] = ['running', 'needs_you']

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
  /** 1 = it ran and had nothing to report; the chat folds these away. */
  quiet: number
  /** 1 = read and put away on Today. */
  dismissed: number
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
