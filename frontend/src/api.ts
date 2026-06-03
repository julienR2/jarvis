const BASE = '/api'

function getToken(): string | null {
  return localStorage.getItem('token')
}

function headers(hasBody: boolean): Record<string, string> {
  const token = getToken()
  return {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function handleUnauthorized() {
  const hadToken = !!localStorage.getItem('token')
  localStorage.removeItem('token')
  if (hadToken && window.location.pathname !== '/login') {
    window.__jarvisToast?.info('Your session expired — please sign in again.')
  }
  if (window.location.pathname !== '/login') {
    window.location.href = '/login'
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(body != null),
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    handleUnauthorized()
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<{ token: string }>('POST', '/auth/login', { email, password }),
  getSetupStatus: () => request<{ needsSetup: boolean; hasToken: boolean }>('GET', '/auth/setup-status'),
  setup: (email: string, password: string) =>
    request<{ token: string }>('POST', '/auth/setup', { email, password }),
  setupToken: (token: string) =>
    request<{ ok: boolean }>('POST', '/auth/setup-token', { token }),
  getMe: () => request<{ id: number; email: string; onboarded: boolean }>('GET', '/auth/me'),
  completeOnboarding: () => request<{ ok: boolean }>('POST', '/auth/complete-onboarding'),

  // Uploads
  uploadFile: async (file: File): Promise<Attachment> => {
    const form = new FormData()
    form.append('file', file)
    const token = getToken()
    const res = await fetch(`${BASE}/uploads`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    if (res.status === 401) handleUnauthorized()
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error || res.statusText)
    }
    return res.json()
  },

  // Conversations
  getConversations: () =>
    request<Conversation[]>('GET', '/conversations'),
  createConversation: (title?: string) =>
    request<Conversation>('POST', '/conversations', { title }),
  getConversation: (id: string) =>
    request<ConversationWithMessages>('GET', `/conversations/${id}`),
  updateConversation: (
    id: string,
    data: { title?: string; notify?: string; model?: string; thinking?: boolean; pinned?: boolean },
  ) => request<Conversation>('PATCH', `/conversations/${id}`, data),
  deleteConversation: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/conversations/${id}`),

  // Messages
  sendMessage: (conversationId: string, content: string, attachments?: Attachment[], model?: string, thinking?: boolean) =>
    request<{ id: string }>('POST', `/conversations/${conversationId}/messages`, {
      content,
      attachments: attachments?.length ? attachments : undefined,
      model,
      thinking,
    }),

  cancelMessage: (conversationId: string) =>
    request<{ ok: boolean }>('POST', `/conversations/${conversationId}/cancel`),

  sendAudio: async (conversationId: string, audioBlob: Blob): Promise<{ id: string; transcript: string }> => {
    const form = new FormData()
    form.append('file', audioBlob, 'audio.webm')
    const token = getToken()
    const res = await fetch(`${BASE}/conversations/${conversationId}/audio`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    if (res.status === 401) handleUnauthorized()
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error || res.statusText)
    }
    return res.json()
  },

  transcribeAudio: async (audioBlob: Blob): Promise<{ transcript: string }> => {
    const form = new FormData()
    form.append('file', audioBlob, 'audio.webm')
    const token = getToken()
    const res = await fetch(`${BASE}/conversations/audio`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    if (res.status === 401) handleUnauthorized()
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error || res.statusText)
    }
    return res.json()
  },

  // Crons
  getCrons: () => request<Cron[]>('GET', '/crons'),
  createCron: (data: CronInput) => request<Cron>('POST', '/crons', data),
  updateCron: (id: string, data: Partial<CronInput>) =>
    request<Cron>('PATCH', `/crons/${id}`, data),
  deleteCron: (id: string) => request<{ ok: boolean }>('DELETE', `/crons/${id}`),
  triggerCron: (id: string) => request<{ ok: boolean }>('POST', `/crons/${id}/trigger`),

  // Webhooks
  getWebhooks: () => request<Webhook[]>('GET', '/webhooks'),
  createWebhook: (data: WebhookInput) => request<Webhook>('POST', '/webhooks', data),
  updateWebhook: (id: string, data: Partial<WebhookInput>) =>
    request<Webhook>('PATCH', `/webhooks/${id}`, data),
  deleteWebhook: (id: string) => request<{ ok: boolean }>('DELETE', `/webhooks/${id}`),
  triggerWebhook: (id: string) => request<{ ok: boolean }>('POST', `/webhooks/${id}/trigger`),

  // Code (repo browser)
  getAgentTree: () => request<CodeEntry[]>('GET', '/git/agent-tree'),
  getCodeTree: () => request<CodeEntry[]>('GET', '/git/tree'),
  getCodeFile: (path: string) =>
    request<CodeFile>('GET', `/git/file?path=${encodeURIComponent(path)}`),
  getCommits: (limit = 50) =>
    request<Commit[]>('GET', `/git/log?limit=${limit}`),
  getCommit: (hash: string) =>
    request<CommitDetail>('GET', `/git/log/${encodeURIComponent(hash)}`),
  getCommitFile: (hash: string, path: string) =>
    request<{ path: string; diff: string }>(
      'GET',
      `/git/log/${encodeURIComponent(hash)}/file?path=${encodeURIComponent(path)}`,
    ),

  // Push notifications
  getVapidKey: () => request<{ key: string }>('GET', '/push/vapid-key'),
  subscribePush: (subscription: PushSubscriptionJSON) =>
    request<{ ok: boolean }>('POST', '/push/subscribe', { subscription }),

  // Connectors
  getConnectors: () => request<ConnectorInfo[]>('GET', '/connectors'),
  getConnector: (id: string) => request<ConnectorDetail>('GET', `/connectors/${id}`),
  saveConnector: (id: string, secrets: Record<string, string>) =>
    request<ConnectorInfo>('POST', `/connectors/${id}`, { secrets }),
  testConnector: (id: string, secrets?: Record<string, string>) =>
    request<{ ok: boolean; message: string }>('POST', `/connectors/${id}/test`, secrets ? { secrets } : {}),
  deleteConnector: (id: string) => request<{ ok: boolean }>('DELETE', `/connectors/${id}`),
  createCustomConnector: (def: { name: string; description: string; icon: string; fields: ConnectorField[] }) =>
    request<{ id: string }>('POST', '/connectors/custom', def),
  updateCustomConnector: (id: string, def: { name?: string; description?: string; icon?: string; fields?: ConnectorField[] }) =>
    request<{ id: string }>('PATCH', `/connectors/custom/${id}`, def),
  deleteCustomConnector: (id: string) => request<{ ok: boolean }>('DELETE', `/connectors/custom/${id}`),
}

// ── SSE connection ───────────────────────────────────────────────────────────

export interface EventConnection {
  close(): void
}

export function connectEvents(
  conversationId: string,
  onEvent: (ev: ChatEvent) => void,
  onStatusChange?: (connected: boolean) => void,
): EventConnection {
  let es: EventSource | null = null
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let lastActivityTime = Date.now()
  const maxDelay = 15000
  const baseDelay = 1000
  // 2 minutes — long enough to ignore normal tab switches,
  // short enough to catch laptop sleep / OS background kill
  const SLEEP_THRESHOLD = 120_000

  function connect() {
    if (stopped) return

    const token = getToken()
    es = new EventSource(`${BASE}/conversations/${conversationId}/events?token=${token}`)

    es.onopen = () => {
      attempt = 0
      lastActivityTime = Date.now()
      onStatusChange?.(true)
    }

    es.onmessage = (e) => {
      lastActivityTime = Date.now()
      try {
        onEvent(JSON.parse(e.data))
      } catch { /* ignore */ }
    }

    es.onerror = () => {
      es?.close()
      es = null
      onStatusChange?.(false)
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (stopped) return
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay)
    attempt++
    reconnectTimer = setTimeout(connect, delay)
  }

  // Force-close stale connection and reconnect with fresh token
  function forceReconnect() {
    if (stopped) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    es?.close()
    es = null
    attempt = 0
    onStatusChange?.(false)
    connect()
  }

  // Detect wake-up from sleep: big time gap or dead connection
  function handleWakeUp() {
    if (document.visibilityState !== 'visible') return
    const slept = Date.now() - lastActivityTime > SLEEP_THRESHOLD
    const dead = !es || es.readyState === EventSource.CLOSED
    if (slept || dead) {
      forceReconnect()
    }
  }

  document.addEventListener('visibilitychange', handleWakeUp)
  window.addEventListener('online', handleWakeUp)

  connect()

  return {
    close() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
      es = null
      document.removeEventListener('visibilitychange', handleWakeUp)
      window.removeEventListener('online', handleWakeUp)
    },
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Conversation {
  id: string
  title: string
  claude_session_id: string | null
  app_path: string | null
  notify: 'subscribe' | 'unsubscribe' | 'auto'
  model: string | null
  thinking: number
  pinned: number
  unread_count: number
  has_cron?: number
  has_webhook?: number
  created_at: number
  updated_at: number
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  type?: 'activity' | 'error' | null
  content: string
  result?: string | null
  metadata?: string | null
  created_at: number
}

export interface ConversationWithMessages extends Conversation {
  messages: Message[]
}

export interface Cron {
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

export interface CronInput {
  name: string
  schedule: string
  prompt: string
  enabled?: boolean
  once?: boolean
  model?: string
  thinking?: boolean
}

export interface Webhook {
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

export interface WebhookInput {
  name: string
  prompt: string
  enabled?: boolean
  model?: string
  thinking?: boolean
}

export interface CodeEntry {
  path: string
  status: string | null
}

export interface CodeFile {
  path: string
  status: string | null
  content: string | null
  binary: boolean
  tooLarge: boolean
  diff: string | null
}

export interface Commit {
  hash: string
  message: string
  author: string
  date: string
}

export interface CommitDetail extends Commit {
  files: CodeEntry[]
}

export interface Attachment {
  id: string
  filename: string
  originalName: string
  mimetype: string
  size: number
  url: string
  path: string
}

export interface ConnectorField {
  key: string
  label: string
  type: 'text' | 'password' | 'email'
  placeholder?: string
}

export interface ConnectorInfo {
  id: string
  name: string
  description: string
  icon: string
  fields: ConnectorField[]
  custom?: boolean
  connected: boolean
  connected_at: number | null
  updated_at: number | null
}

export interface ConnectorDetail extends ConnectorInfo {
  secrets: Record<string, string>
}

export type ChatEvent =
  | { type: 'message'; message: Message }
  | { type: 'conversation'; id: string; title?: string }
  | { type: 'thinking'; thinking: boolean }
  | { type: 'app_updated' }

export type GlobalEvent =
  | { type: 'new_message'; conversation_id: string }

// ── Global SSE connection ────────────────────────────────────────────────────

export function connectGlobalEvents(
  onEvent: (ev: GlobalEvent) => void,
): EventConnection {
  let es: EventSource | null = null
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let lastActivityTime = Date.now()
  const maxDelay = 15000
  const baseDelay = 1000
  const SLEEP_THRESHOLD = 120_000

  function connect() {
    if (stopped) return

    const token = getToken()
    es = new EventSource(`${BASE}/events?token=${token}`)

    es.onopen = () => {
      attempt = 0
      lastActivityTime = Date.now()
    }

    es.onmessage = (e) => {
      lastActivityTime = Date.now()
      try {
        onEvent(JSON.parse(e.data))
      } catch { /* ignore */ }
    }

    es.onerror = () => {
      es?.close()
      es = null
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (stopped) return
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay)
    attempt++
    reconnectTimer = setTimeout(connect, delay)
  }

  function handleWakeUp() {
    if (document.visibilityState !== 'visible') return
    const slept = Date.now() - lastActivityTime > SLEEP_THRESHOLD
    const dead = !es || es.readyState === EventSource.CLOSED
    if (slept || dead) {
      if (stopped) return
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
      es = null
      attempt = 0
      connect()
    }
  }

  document.addEventListener('visibilitychange', handleWakeUp)
  window.addEventListener('online', handleWakeUp)

  connect()

  return {
    close() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
      es = null
      document.removeEventListener('visibilitychange', handleWakeUp)
      window.removeEventListener('online', handleWakeUp)
    },
  }
}
