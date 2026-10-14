import { api, type Cron, type CronInput, type Webhook } from '../api'

/**
 * A routine is a saved prompt Jarvis runs without you: on a schedule, or when
 * something calls its link. Under the hood still two rows (a cron, a webhook);
 * to the person, one thing — a thread that runs by itself.
 */
export type Routine =
  | { kind: 'cron'; row: Cron }
  | { kind: 'webhook'; row: Webhook }

export type RoutineKind = Routine['kind']

/** The public URL a webhook routine answers to. The token is the secret. */
export function webhookUrl(token: string): string {
  return `${window.location.origin}/api/hooks/${token}/trigger`
}

export const ROUTINE_CHANGED_EVENT = 'jarvis:routine-changed'

/** Where a routine is seen and edited: its thread (settings open, if asked). */
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

export function updateRoutine(r: Routine, patch: Partial<CronInput>): Promise<Cron | Webhook> {
  if (r.kind === 'cron') return api.updateCron(r.row.id, patch)
  const { schedule: _schedule, once: _once, ...rest } = patch
  return api.updateWebhook(r.row.id, rest)
}
