import { API_BASE, BASE_PATH } from './base'

const BASE = API_BASE

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

  // Compared against the mounted path, not a bare '/login': under a sub-path
  // mount the login page is at '<base>/login', and treating it as "somewhere
  // else" turned a wrong password into a silent full reload of the form.
  const onLogin = window.location.pathname === `${BASE_PATH}/login`
  const hadToken = !!localStorage.getItem('token')
  localStorage.removeItem('token')
  if (hadToken && !onLogin) {
    window.__jarvisToast?.info('Your session expired — please sign in again.')
  }
  if (!onLogin) {
    window.location.href = `${BASE_PATH}/login`
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
  // The newest page of messages WITHOUT marking the conversation read — what
  // Today's cards show. Opening the chat (getConversation) is what marks it.
  getMessages: (id: string, limit?: number) =>
    request<MessagePage>('GET', `/conversations/${id}/messages${limit ? `?limit=${limit}` : ''}`),
  // Older messages, walking backwards from a message's `seq`.
  getOlderMessages: (id: string, before: number, limit?: number) =>
    request<MessagePage>(
      'GET',
      `/conversations/${id}/messages?before=${before}${limit ? `&limit=${limit}` : ''}`,
    ),
  updateConversation: (
    id: string,
    data: { title?: string; notify?: string; section_id?: string | null },
  ) => request<Conversation>('PATCH', `/conversations/${id}`, data),
  // Files are archived and routines kept unless told otherwise — the delete
  // dialog's two checkboxes, both off by default.
  /** Mark read without opening — Today's ✓ on a chat's card. */
  markConversationRead: (id: string) => request<{ ok: boolean }>('POST', `/conversations/${id}/read`),
  deleteConversation: (id: string, opts: DeleteOptions = {}) => {
    const q = new URLSearchParams()
    if (opts.files) q.set('files', 'delete')
    if (opts.routines) q.set('routines', 'delete')
    const qs = q.toString()
    return request<{ ok: boolean }>('DELETE', `/conversations/${id}${qs ? `?${qs}` : ''}`)
  },

  // Sections (sidebar groups). The default "Chats" group is section_id === null
  // and has no row of its own.
  getSections: () => request<Section[]>('GET', '/sections'),
  createSection: (name: string) => request<Section>('POST', '/sections', { name }),
  renameSection: (id: string, name: string) =>
    request<Section>('PATCH', `/sections/${id}`, { name }),
  getSection: (id: string) => request<Section>('GET', `/sections/${id}`),
  /** Rewrite a topic's brief (and/or rename it). */
  updateSection: (id: string, data: { name?: string; context?: string; brief_hidden?: boolean }) =>
    request<Section>('PATCH', `/sections/${id}`, data),
  /** Ask Jarvis to rewrite the brief from the topic's chats; answers with the chat it runs in. */
  consolidateSection: (id: string) =>
    request<{ conversation_id: string }>('POST', `/sections/${id}/consolidate`),
  reorderSections: (ids: string[]) =>
    request<Section[]>('PUT', '/sections/order', { ids }),
  deleteSection: (id: string) => request<{ ok: boolean }>('DELETE', `/sections/${id}`),

  // Messages
  sendMessage: (conversationId: string, content: string, attachments?: Attachment[], model?: string, effort?: Effort, replyTo?: ReplyTo | null) =>
    request<{ id: string }>('POST', `/conversations/${conversationId}/messages`, {
      content,
      attachments: attachments?.length ? attachments : undefined,
      model,
      effort,
      reply_to: replyTo ?? undefined,
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

  // Runs — one row per cron/webhook fire. Scoped to a conversation here
  // because that is where they are shown; the unscoped list is the same
  // endpoint without the parameter.
  listRuns: (conversationId: string, limit = 50) =>
    request<Run[]>('GET', `/runs?conversation_id=${conversationId}&limit=${limit}`),
  stopRun: (runId: string) =>
    request<{ stopped: boolean }>('POST', `/runs/${runId}/stop`),
  /** The Activity log: every conversation, filtered and paged by `seq`. */
  listRunsAll: (opts: {
    status?: RunStatus[]
    kind?: 'cron' | 'webhook'
    sectionId?: string
    since?: number
    /** `<started_at>:<seq>` of the last row seen. */
    before?: string
    limit?: number
  } = {}) => {
    const q = new URLSearchParams()
    if (opts.status?.length) q.set('status', opts.status.join(','))
    if (opts.kind) q.set('kind', opts.kind)
    if (opts.sectionId) q.set('section_id', opts.sectionId)
    if (opts.since) q.set('since', String(opts.since))
    if (opts.before) q.set('before', opts.before)
    if (opts.limit) q.set('limit', String(opts.limit))
    return request<RunListItem[]>('GET', `/runs?${q}`)
  },
  retryRun: (runId: string) => request<{ ok: boolean }>('POST', `/runs/${runId}/retry`),
  /** Put a finished run away: Today stops listing it. */
  dismissRun: (runId: string) => request<{ dismissed: boolean }>('POST', `/runs/${runId}/dismiss`),
  /** Answer the conversation's pending question or decide on its tool call. */
  answerQuestion: (conversationId: string, body: AnswerBody) =>
    request<{ answered: boolean; error?: string }>('POST', `/conversations/${conversationId}/answer`, body),

  // Fire-and-forget: the server transcribes and posts the message in the
  // background (survives the client navigating away), so there's nothing to
  // return — the message arrives over the conversation event stream.
  sendAudio: async (conversationId: string, audioBlob: Blob, model?: string, effort?: Effort): Promise<void> => {
    const form = new FormData()
    form.append('file', audioBlob, 'audio.webm')
    const token = getToken()
    const query = new URLSearchParams()
    if (model) query.set('model', model)
    if (effort) query.set('effort', effort)
    const qs = query.size ? `?${query}` : ''
    const res = await fetch(`${BASE}/conversations/${conversationId}/audio${qs}`, {
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
  /** Enabled crons with their next fire, soonest first — Today's "Coming up". */
  getUpcomingCrons: () => request<UpcomingCron[]>('GET', '/crons/upcoming'),
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

  // API keys
  getApiKeys: () => request<ApiKey[]>('GET', '/api-keys'),
  // `key` is present on this response and nowhere else — the backend stores
  // only a hash, so a key not saved now is a key gone for good.
  createApiKey: (name: string) =>
    request<ApiKey & { key: string }>('POST', '/api-keys', { name }),
  deleteApiKey: (id: string) => request<{ ok: boolean }>('DELETE', `/api-keys/${id}`),

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
  testPush: () => request<{ delivered: number }>('POST', '/push/test'),

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

/** 'high' = the Think hard switch is on (--effort high); 'default' = no flag, the model decides. */
export type Effort = 'default' | 'high'

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

/** A passage of an earlier message the person is replying to. */
export interface ReplyTo {
  message_id: string
  text: string
}

/** What goes with a deleted conversation besides its messages. */
export interface DeleteOptions {
  /** Delete the chat's uploads and app for good instead of archiving them. */
  files?: boolean
  /** Delete the routines posting into it instead of leaving them to open a new chat. */
  routines?: boolean
}

export interface Conversation {
  id: string
  title: string
  claude_session_id: string | null
  app_path: string | null
  notify: 'subscribe' | 'unsubscribe' | 'auto'
  /** The last model/effort sent with here — where the input starts. Null = instance default. */
  model: string | null
  effort: Effort
  /** Legacy column, unused since reasoning summaries were removed. */
  thinking: number
  section_id: string | null
  /** Context fill as of the last assistant message — null until the first turn. */
  context_tokens: number | null
  context_window: number | null
  unread_count: number
  /** Non-null while a share link is live — 'read' or 'write'. */
  share_mode: 'read' | 'write' | null
  has_cron?: number
  has_webhook?: number
  /** JSON of a PendingQuestion while Jarvis waits on you — see pendingQuestionOf. */
  pending_question?: string | null
  /** When you last read it (opening the chat, or "mark as read" on Today). */
  last_read_at?: number | null
  /** When a push last went out for it; Today ranks a notified chat above a merely unread one. */
  notified_at?: number | null
  created_at: number
  updated_at: number
}

/**
 * What a conversation is waiting on: a question Jarvis asked (AskUserQuestion —
 * `input.questions`) or a tool call awaiting approval (any other tool_name).
 */
export interface PendingQuestion {
  request_id: string
  tool_name: string
  tool_use_id: string | null
  input: Record<string, unknown>
  session_key: string
  run_id: string | null
  asked_at: number
}

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  question: string
  header?: string
  options: AskOption[]
  multiSelect?: boolean
}

export function pendingQuestionOf(conv: Pick<Conversation, 'pending_question'> | undefined): PendingQuestion | null {
  if (!conv?.pending_question) return null
  try {
    return JSON.parse(conv.pending_question) as PendingQuestion
  } catch {
    return null
  }
}

/** The questions of an AskUserQuestion prompt; empty for a tool approval. */
export function questionsOf(q: PendingQuestion): AskQuestion[] {
  if (q.tool_name !== 'AskUserQuestion') return []
  const list = (q.input as { questions?: unknown }).questions
  return Array.isArray(list) ? (list as AskQuestion[]).filter((x) => x && typeof x.question === 'string') : []
}

/** One line saying what is being waited on — the row summary outside the chat. */
export function describePending(q: PendingQuestion): string {
  const questions = questionsOf(q)
  if (questions.length) return questions.map((x) => x.question).join(' · ')
  const input = q.input as Record<string, unknown>
  const detail =
    typeof input.description === 'string' ? input.description
    : typeof input.command === 'string' ? input.command
    : typeof input.file_path === 'string' ? input.file_path
    : typeof input.url === 'string' ? input.url
    : ''
  const name = q.tool_name.replace(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/, '$1: $2').replace(/_/g, ' ')
  return detail ? `Approve ${name}: ${detail}` : `Approve ${name}`
}

export interface AnswerBody {
  request_id: string
  answers?: Record<string, string>
  behavior?: 'allow' | 'deny'
  message?: string
  /** Files sent with a typed answer, already uploaded. */
  attachments?: Attachment[]
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  type?: 'activity' | 'error' | null
  content: string
  result?: string | null
  metadata?: string | null
  /** Sent with (user) or answered by (assistant); null on older rows. */
  model?: string | null
  effort?: Effort | null
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

export interface Run {
  id: string
  kind: 'cron' | 'webhook'
  source_id: string | null
  source_name: string
  conversation_id: string
  /** Engine session key; null when the run used the conversation's own. */
  run_key: string | null
  /** 0 = the run could not see this conversation's history. */
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

export type RunStatus = 'running' | 'needs_you' | 'done' | 'error' | 'stopped' | 'interrupted'

/** A run as the Activity page lists it. */
export interface RunListItem extends Run {
  /** Insertion order — the paging cursor. */
  seq: number
  conversation_title: string | null
  section_id: string | null
}

export interface Section {
  id: string
  name: string
  position: number
  /** The topic's shared brief, markdown — empty for a plain group. */
  context: string
  context_updated_at: number | null
  /** 1 when the group is a plain folder: the brief is hidden and not given to its chats. */
  brief_hidden: number
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
  /** 0 = each fire runs in its own session, only posting into the conversation. */
  inherit_context: number
  /** 1 = a fire is skipped while any run is still active anywhere. */
  solo: number
  model: string | null
  effort: Effort
  last_run: number | null
  last_result: string | null
  created_at: number
}

export interface UpcomingCron {
  id: string
  name: string
  schedule: string
  conversation_id: string | null
  /** Unix seconds; null when the scheduler holds no task for it. */
  next_run: number | null
}

export interface CronInput {
  name: string
  schedule: string
  prompt: string
  enabled?: boolean
  once?: boolean
  inherit_context?: boolean
  solo?: boolean
  model?: string
  effort?: Effort
  /** The chat the runs post into; null = open one on the first fire. */
  conversation_id?: string | null
}

export interface Webhook {
  id: string
  name: string
  token: string
  prompt: string
  conversation_id: string | null
  enabled: number
  /** 0 = each trigger runs in its own session, only posting into the conversation. */
  inherit_context: number
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
  inherit_context?: boolean
  model?: string
  effort?: Effort
  /** The chat the runs post into; null = open one on the first trigger. */
  conversation_id?: string | null
}

export interface ApiKey {
  id: string
  name: string
  /** Opening characters only — enough to recognise a key, not to use it. */
  prefix: string
  last_used_at: number | null
  created_at: number
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
  // The conversation's in-flight cron/webhook runs, whole list on every change
  // (and once on connect). An empty array is meaningful: it clears the pill.
  | { type: 'runs'; runs: Run[] }
  // What the conversation waits on changed: a question opened (payload) or
  // closed (null).
  | { type: 'question'; question: PendingQuestion | null }
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
  // A run started or ended somewhere. A nudge, not a payload: whoever shows
  // runs outside a conversation refetches.
  | { type: 'runs'; conversation_id: string }
  // A conversation started or stopped waiting on you. Carries the payload so
  // the loaded list can be patched in place.
  | { type: 'question'; conversation_id: string; question: PendingQuestion | null }
  // A topic was renamed, rewritten or removed — refetch the sections.
  | { type: 'sections' }

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
