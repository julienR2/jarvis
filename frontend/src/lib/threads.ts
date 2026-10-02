import type { Conversation } from '../api'

/** A picker's "current" for a thread: none of the groups, so every one is a move. */
export const THREAD_GROUP = '__threads__'

/**
 * Filing a thread does more than it looks: it becomes a chat — the routine's
 * chat from then on, which its runs report into from a new thread. Asked
 * once, here, rather than left as a surprise.
 */
export function confirmThreadMove(conv: Conversation | undefined): boolean {
  if (conv?.kind !== 'thread') return true
  return confirm(
    `Move "${conv.title}" into the chats?\n\nIt becomes a regular chat. Its routine will report into it, and run from a new thread from its next run on.`,
  )
}

/** In the sidebar: every chat, and a thread while it is surfaced. */
export function isListed(conv: Conversation): boolean {
  return conv.kind !== 'thread' || !!conv.surfaced_at
}

/**
 * A thread opened to set up a routine that does not exist yet, and never ran
 * one: putting it away throws it away.
 */
export function isDraftThread(conv: Conversation | undefined): boolean {
  return conv?.kind === 'thread' && !conv.thread_of && !conv.has_runs && !conv.parent_message_id
}
