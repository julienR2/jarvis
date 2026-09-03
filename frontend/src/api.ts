const BASE = '/api'

// Origin that serves generated apps. Same origin by default, which keeps a
// zero-config deploy working; set VITE_APPS_ORIGIN to a different host or port
// to give apps their own origin, so an app cannot reach the SPA's page or
// storage even though it runs with allow-same-origin (it needs that for its own
// localStorage). Documented in .env.example.
export const APPS_ORIGIN: string =
  import.meta.env.VITE_APPS_ORIGIN?.replace(/\/+$/, '') || ''

/**
 * Credential used for a shared conversation, in place of the account session.
 *
 * A visitor on /s/:token has no account. Setting this lets the ordinary API
 * layer — and therefore the ordinary chat components — work unchanged for
 * them, with the backend confining the token to its one conversation.
 */
let shareToken: string | null = null

export function useShareCredential(token: string | null): void {
  shareToken = token
}

export function isSharedSession(): boolean {
  return shareToken !== null
}

function getToken(): string | null {
  return shareToken ?? localStorage.getItem('token')
}

function headers(hasBody: boolean): Record<string, string> {
  const token = getToken()
  return {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function handleUnauthorized() {
  // A visitor on a share link has no session to expire and no login to be sent
  // to — a revoked or mistyped link should say so where they are, not bounce
  // them to a sign-in page for an account they don't have.
  if (shareToken !== null) return

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
  setup: (email: string, password: string, setupCode: string) =>
    request<{ token: string }>('POST', '/auth/setup', { email, password, setupCode }),
  setupToken: (token: string) =>
    request<{ ok: boolean }>('POST', '/auth/setup-token', { token }),
  getBrowserStatus: () => request<{ enabled: boolean }>('GET', '/browser-status'),
  // Server-fed so switching provider changes the picker without a rebuild.
  getModels: () => request<ModelCatalogue>('GET', '/models'),
  getConnection: () => request<ConnectionStatus>('GET', '/auth/connection'),
  setConnection: (body: { mode: 'anthropic' | 'gateway'; baseUrl: string; credential: string }) =>
    request<{ ok: boolean; busy: string[] }>('POST', '/auth/connection', body),
  setConnectionDefaults: (body: {
    provider?: 'anthropic' | 'gateway'
    anthropicModel?: string
    gatewayModel?: string
  }) =>
    request<{
      ok: boolean
      defaultProvider: 'anthropic' | 'gateway'
      anthropicModel: string
      gatewayModel: string
    }>('PUT', '/auth/connection/defaults', body),
  clearConnection: (provider: 'anthropic' | 'gateway') =>
    request<{ ok: boolean }>('DELETE', `/auth/connection/${provider}`),
  // Mirrors the session into an httpOnly cookie so <img>/<a> inside chat and
  // apps can load uploads and proxied connector content, which can't send an
  // Authorization header. Best-effort: failure only costs inline media.
  syncSessionCookie: () =>
    request<{ ok: boolean }>('POST', '/auth/session-cookie').catch(() => ({ ok: false })),
  getMe: () => request<{ id: number; email: string; onboarded: boolean }>('GET', '/auth/me'),
  completeOnboarding: () => request<{ ok: boolean }>('POST', '/auth/complete-onboarding'),

  // Uploads
  // `conversationId` files the upload under uploads/<id>/ so it can be cleaned
  // up with the conversation. Omitted when there is no conversation yet (share
  // intent into a not-yet-created chat) — those land flat, as before.
  uploadFile: async (file: File, conversationId?: string): Promise<Attachment> => {
    const form = new FormData()
    form.append('file', file)
    const token = getToken()
    const qs = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''
    const res = await fetch(`${BASE}/uploads${qs}`, {
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
  // Messages come back as the newest page (oldest-first within the page).
  // `limit` is how many of them to load — pass the count already held to keep
  // previously paged-in history when re-syncing.
  getConversation: (id: string, limit?: number) =>
    request<ConversationWithMessages>(
      'GET',
      `/conversations/${id}${limit ? `?limit=${limit}` : ''}`,
    ),
  // Older messages, walking backwards from a message's `seq`.
  getOlderMessages: (id: string, before: number, limit?: number) =>
    request<MessagePage>(
      'GET',
      `/conversations/${id}/messages?before=${before}${limit ? `&limit=${limit}` : ''}`,
    ),
  updateConversation: (
    id: string,
    data: { title?: string; notify?: string; model?: string; effort?: Effort; section_id?: string | null },
  ) => request<Conversation>('PATCH', `/conversations/${id}`, data),
  deleteConversation: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/conversations/${id}`),

  // Sections (sidebar groups). The default "Chats" group is section_id === null
  // and has no row of its own.
  getSections: () => request<Section[]>('GET', '/sections'),
  createSection: (name: string) => request<Section>('POST', '/sections', { name }),
  renameSection: (id: string, name: string) =>
    request<Section>('PATCH', `/sections/${id}`, { name }),
  reorderSections: (ids: string[]) =>
    request<Section[]>('PUT', '/sections/order', { ids }),
  deleteSection: (id: string) => request<{ ok: boolean }>('DELETE', `/sections/${id}`),

  // Messages
  sendMessage: (conversationId: string, content: string, attachments?: Attachment[], model?: string, effort?: Effort) =>
    request<{ id: string }>('POST', `/conversations/${conversationId}/messages`, {
      content,
      attachments: attachments?.length ? attachments : undefined,
      model,
      effort,
    }),

  // App share link. The token is scoped to this conversation's app and carries
  // no account rights, unlike the session JWT these URLs used to embed.
  getAppToken: (conversationId: string) =>
    request<{ token: string }>('GET', `/conversations/${conversationId}/app-token`),
  rotateAppToken: (conversationId: string) =>
    request<{ token: string }>('POST', `/conversations/${conversationId}/app-token/rotate`),

  // Conversation sharing (owner side).
  getShare: (conversationId: string) =>
    request<{ mode: 'read' | 'write' | null; token: string | null }>(
      'GET', `/conversations/${conversationId}/share`),
  setShare: (conversationId: string, mode: 'read' | 'write' | null, rotate = false) =>
    request<{ mode: 'read' | 'write' | null; token: string | null }>(
      'PUT', `/conversations/${conversationId}/share`, { mode, rotate }),

  cancelMessage: (conversationId: string) =>
    request<{ ok: boolean }>('POST', `/conversations/${conversationId}/cancel`),

  // Fire-and-forget: the server transcribes and posts the message in the
  // background (survives the client navigating away), so there's nothing to
  // return — the message arrives over the conversation event stream.
  sendAudio: async (conversationId: string, audioBlob: Blob): Promise<void> => {
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
  // Recovery. The backend has had these since the beginning; nothing called
  // them, so the safety net the docs promised wasn't actually reachable.
  commitChanges: (message: string) =>
    request<{ ok: boolean }>('POST', '/git/commit', { message }),
  discardChanges: () =>
    request<{ ok: boolean; message: string }>('POST', '/git/discard'),
  revertLastCommit: () =>
    request<{ ok: boolean; message: string }>('POST', '/git/revert'),

  // Push notifications
  getVapidKey: () => request<{ key: string }>('GET', '/push/vapid-key'),
  subscribePush: (subscription: PushSubscriptionJSON) =>
    request<{ ok: boolean }>('POST', '/push/subscribe', { subscription }),

  // Connectors
  getConnectors: () => request<ConnectorInfo[]>('GET', '/connectors'),
  getConnector: (id: string) => request<ConnectorDetail>('GET', `/connectors/${id}`),
  createConnector: (def: ConnectorInput) =>
    request<ConnectorDetail>('POST', '/connectors', def),
  updateConnector: (id: string, def: ConnectorInput) =>
    request<ConnectorDetail>('PATCH', `/connectors/${id}`, def),
  deleteConnector: (id: string) => request<{ ok: boolean }>('DELETE', `/connectors/${id}`),

  // Plugins & marketplaces
  getPlugins: () => request<PluginState>('GET', '/plugins'),
  addMarketplace: (source: string) =>
    request<PluginMutation>('POST', '/plugins/marketplaces', { source }),
  updateMarketplace: (name: string) =>
    request<PluginMutation>('POST', `/plugins/marketplaces/${encodeURIComponent(name)}/update`),
  removeMarketplace: (name: string) =>
    request<PluginMutation>('DELETE', `/plugins/marketplaces/${encodeURIComponent(name)}`),
  installPlugin: (pluginId: string) =>
    request<PluginMutation>('POST', '/plugins/install', { pluginId }),
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    request<PluginMutation>('POST', `/plugins/${encodeURIComponent(pluginId)}/enabled`, {
      enabled,
    }),
  setPluginAlwaysOn: (pluginId: string, alwaysOn: boolean) =>
    request<PluginMutation>('POST', `/plugins/${encodeURIComponent(pluginId)}/always-on`, {
      alwaysOn,
    }),
  updatePlugin: (pluginId: string) =>
    request<PluginMutation>('POST', `/plugins/${encodeURIComponent(pluginId)}/update`),
  uninstallPlugin: (pluginId: string) =>
    request<PluginMutation>('DELETE', `/plugins/${encodeURIComponent(pluginId)}`),
  getPluginDetails: (pluginId: string) =>
    request<{ details: string }>('GET', `/plugins/${encodeURIComponent(pluginId)}/details`),
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

/**
 * Add the session token to a same-origin media URL.
 *
 * Uploaded files and proxied connector content are authenticated, but they are
 * loaded by `<img>`/`<a>`, which can't send a header. The session cookie covers
 * this, but it is established asynchronously on boot and a failed image load
 * never retries — so put the token on the URL too rather than racing it.
 */
export function withMediaToken(url?: string): string {
  if (!url) return ''
  if (!url.startsWith('/api/uploads/files/') && !url.includes('/proxy/')) return url
  const token = getToken()
  if (!token) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

// ── Shared conversations ──────────────────────────────────────────────────────

export interface SharedConversationRef {
  id: string
  title: string
  mode: 'read' | 'write'
}

/** Resolve a share link to the conversation it opens. Public, no session. */
export async function resolveShare(token: string): Promise<SharedConversationRef> {
  const res = await fetch(`${BASE}/shared/${encodeURIComponent(token)}`)
  if (!res.ok) throw new Error('This link is no longer valid.')
  return res.json()
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Effort = 'low' | 'medium' | 'high' | 'max'

export interface ModelCatalogue {
  provider: 'anthropic' | 'gateway'
  models: { id: string; name: string; desc: string; effort?: boolean }[]
  default: string
  /** Gateways serve more than they list; let the user type an id. */
  allowCustom?: boolean
  error?: string
}

export interface ProviderStatus {
  configured: boolean
  credentialHint: string
  envManaged: boolean
  baseUrl?: string
  /** The model this provider starts new conversations on. */
  defaultModel: string
}

/** Both providers, independently configurable. */
export interface ConnectionStatus {
  anthropic: ProviderStatus
  gateway: ProviderStatus
  /** Which provider new conversations belong to. Forced when only one is set up. */
  defaultProvider: 'anthropic' | 'gateway'
}

export interface Conversation {
  id: string
  title: string
  claude_session_id: string | null
  app_path: string | null
  notify: 'subscribe' | 'unsubscribe' | 'auto'
  model: string | null
  effort: Effort
  section_id: string | null
  /** Context fill as of the last assistant message — null until the first turn. */
  context_tokens: number | null
  context_window: number | null
  unread_count: number
  /** Non-null while a share link is live — 'read' or 'write'. */
  share_mode: 'read' | 'write' | null
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
  /** Server-side insertion order — the pagination cursor. */
  seq: number
}

export interface MessagePage {
  messages: Message[]
  /** Whether older messages exist before `messages[0]`. */
  has_more: boolean
}

export interface ConversationWithMessages extends Conversation, MessagePage {}

export interface Section {
  id: string
  name: string
  position: number
  created_at: number
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
  effort: Effort
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
  effort?: Effort
}

export interface Webhook {
  id: string
  name: string
  token: string
  prompt: string
  conversation_id: string | null
  enabled: number
  model: string | null
  effort: Effort
  last_run: number | null
  last_result: string | null
  created_at: number
}

export interface WebhookInput {
  name: string
  prompt: string
  enabled?: boolean
  model?: string
  effort?: Effort
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
  value: string
  type?: 'text' | 'password' | 'email'
}

export interface ConnectorProxy {
  baseUrlField: string
  authHeader?: { name: string; valueField: string }
  cookieField?: { name: string; valueField: string }
}

// List view: fields carry no values.
export interface ConnectorInfo {
  id: string
  name: string
  description: string
  icon: string
  fields: Array<Pick<ConnectorField, 'key' | 'label' | 'type'>>
  proxy?: ConnectorProxy
  created_at: number
  updated_at: number
}

// Detail view (for editing): fields include their values.
export interface ConnectorDetail extends Omit<ConnectorInfo, 'fields'> {
  fields: ConnectorField[]
}

export interface ConnectorInput {
  name?: string
  description?: string
  icon?: string
  fields?: Array<{ key?: string; label: string; value: string; type?: ConnectorField['type'] }>
  proxy?: ConnectorProxy | null
}

// ── Plugins ──────────────────────────────────────────────────────────────────

export interface Marketplace {
  name: string
  source: string
  repo?: string
  url?: string
  path?: string
  installLocation?: string
}

export interface InstalledPlugin {
  id: string
  name: string
  marketplace: string
  description?: string
  version?: string
  scope?: string
  enabled: boolean
  installedAt?: string
  lastUpdated?: string
  // Always-on = the plugin's opt-in flag file exists, so its SessionStart hook
  // forces it into every session. Only some plugins read one.
  alwaysOnSupported: boolean
  alwaysOn: boolean
}

export interface AvailablePlugin {
  pluginId: string
  name: string
  description?: string
  marketplaceName: string
  version?: string
}

export interface PluginState {
  marketplaces: Marketplace[]
  installed: InstalledPlugin[]
  available: AvailablePlugin[]
}

// Every mutation answers with the refreshed state, so the page never needs a
// follow-up GET — plus which conversations were recycled to pick the change up.
export interface PluginMutation extends PluginState {
  message: string
  recycled: string[]
  busy: string[]
}

export type ChatEvent =
  | { type: 'message'; message: Message }
  | { type: 'conversation'; id: string; title?: string }
  | { type: 'thinking'; thinking: boolean }
  | { type: 'app_updated' }
  | { type: 'usage'; contextTokens: number; contextWindow: number | null }
  // Live-only, never persisted: answer text as it is written (append). Dropped
  // once the authoritative `message` for the turn arrives — see the chat store's
  // clearLive.
  | { type: 'delta'; text: string }

export type GlobalEvent =
  | { type: 'new_message'; conversation_id: string }
  // A new frontend build landed (Jarvis edited its own UI). The tab is running
  // stale code until it reloads — see useFrontendUpdate.
  | { type: 'frontend_updated' }

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
