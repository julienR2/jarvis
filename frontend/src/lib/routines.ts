import { api, type Conversation, type Cron, type CronInput, type Webhook, type WebhookInput } from '../api'

/**
 * A routine is a saved prompt Jarvis runs without you: on a schedule, or when
 * something calls its link. Under the hood still two rows (a cron, a webhook);
 * to the person, one thing — a thread that runs by itself.
 */
export type Routine =
  | { kind: 'cron'; row: Cron }
  | { kind: 'webhook'; row: Webhook }

export type RoutineKind = Routine['kind']

export type Notify = Conversation['notify']
export const NOTIFY_OPTIONS: [Notify, string][] = [
  ['auto', 'Auto — when a run is worth it'],
  ['subscribe', 'Always'],
  ['unsubscribe', 'Never'],
]
export const HOOK_NOTIFY: Record<Notify, Webhook['notify']> = { auto: 'auto', subscribe: 'always', unsubscribe: 'never' }

/** The public URL a webhook routine answers to. The token is the secret. */
export function webhookUrl(token: string): string {
  return `${window.location.origin}/api/hooks/${token}/trigger`
}

/** Where a routine is seen and edited: its thread, settings open. */
export function routinePath(r: Routine, open = true): string {
  return r.row.thread_id ? `/c/${r.row.thread_id}${open ? '?routine=open' : ''}` : '/routines'
}

export async function listRoutines(): Promise<Routine[]> {
  const [crons, hooks] = await Promise.all([api.getCrons(), api.getWebhooks()])
  const all: Routine[] = [
    ...crons.map((row): Routine => ({ kind: 'cron', row })),
    ...hooks.map((row): Routine => ({ kind: 'webhook', row })),
  ]
  return all.sort((a, b) => a.row.name.localeCompare(b.row.name))
}

/** A thread's routine, from its `thread_of` (`cron:<id>` / `webhook:<id>`). */
export async function routineOf(threadOf: string): Promise<Routine | null> {
  const [kind, id] = threadOf.split(':') as [RoutineKind, string]
  if (kind === 'cron') {
    const row = (await api.getCrons()).find((c) => c.id === id)
    return row ? { kind, row } : null
  }
  const row = (await api.getWebhooks()).find((h) => h.id === id)
  return row ? { kind: 'webhook', row } : null
}

/** What the settings panel edits — everything but the prompt, which the composer holds. */
export interface RoutineSettingsDraft {
  kind: RoutineKind
  name: string
  schedule: string
  conversation_id: string | null
  notify: Notify
  enabled: boolean
}

export function draftOf(r: Routine, threadNotify?: Notify): RoutineSettingsDraft {
  return {
    kind: r.kind,
    name: r.row.name,
    schedule: r.kind === 'cron' ? r.row.schedule : '',
    conversation_id: r.row.conversation_id,
    notify: threadNotify ?? 'auto',
    enabled: !!r.row.enabled,
  }
}

/** Why the draft can't be saved yet, or null. */
export function draftProblem(d: RoutineSettingsDraft): string | null {
  if (!d.name.trim()) return 'Give it a name'
  if (d.kind === 'cron' && !d.schedule.trim()) return 'Give it a schedule'
  return null
}

/** Create a routine; answers with the row, its thread already opened. */
export function createRoutine(
  d: RoutineSettingsDraft,
  prompt: string,
  model: string,
  effort: CronInput['effort'],
): Promise<Cron | Webhook> {
  const common = { name: d.name.trim(), prompt, enabled: d.enabled, model, effort, conversation_id: d.conversation_id }
  if (d.kind === 'cron') return api.createCron({ ...common, schedule: d.schedule.trim(), notify: d.notify })
  const body: WebhookInput = { ...common, notify: HOOK_NOTIFY[d.notify] }
  return api.createWebhook(body)
}

export function updateRoutine(r: Routine, patch: Partial<CronInput & { notify: Notify }>): Promise<Cron | Webhook> {
  if (r.kind === 'cron') return api.updateCron(r.row.id, patch)
  const { notify, schedule: _schedule, once: _once, ...rest } = patch
  return api.updateWebhook(r.row.id, { ...rest, ...(notify ? { notify: HOOK_NOTIFY[notify] } : {}) })
}
