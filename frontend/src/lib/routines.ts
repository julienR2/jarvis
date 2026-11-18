import { api, type Cron, type CronInput, type Effort, type Webhook, type WebhookInput } from '../api'
import { useChatStore } from '../stores/chatStore'
import type { NewRoutine } from '../components/RoutineStrip'

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

export function updateRoutine(r: Routine, patch: Partial<CronInput & WebhookInput>): Promise<Cron | Webhook> {
  if (r.kind === 'cron') {
    const { thread_per_fire: _perFire, ...cron } = patch
    return api.updateCron(r.row.id, cron)
  }
  const { schedule: _schedule, once: _once, ...rest } = patch
  return api.updateWebhook(r.row.id, rest)
}

/**
 * Create a routine from the composer (RoutineStrip): in the conversation it
 * was started in (`threadId`, an empty chat), or in a new one under `parentId`
 * — or at the top level. Answers with its conversation.
 */
export async function createRoutine(
  r: NewRoutine,
  where: { parentId?: string | null; threadId?: string; model?: string; effort?: Effort },
): Promise<string> {
  const common = {
    name: r.name,
    prompt: r.prompt,
    model: where.model,
    effort: where.effort,
    conversation_id: where.parentId ?? null,
    ...(where.threadId ? { thread_id: where.threadId } : {}),
  }
  const row = r.kind === 'cron'
    ? await api.createCron({ ...common, schedule: r.schedule })
    : await api.createWebhook({ ...common, thread_per_fire: r.thread_per_fire })
  await useChatStore.getState().loadConversations()
  window.__jarvisToast?.info(r.kind === 'cron'
    ? `${r.name} is set. Its settings are behind the chip at the top.`
    : `${r.name} is set. Its link is behind the chip at the top.`)
  return row.thread_id ?? where.threadId ?? ''
}
