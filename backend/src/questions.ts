// Pending questions — what a conversation is waiting on.
//
// Claude Code's own mechanism does the asking: AskUserQuestion, and any tool
// call the permission rules escalate, reach the engine as a `can_use_tool`
// control request and park the turn. This module owns the backend's record of
// that state — one JSON blob on the conversation, mirrored on its run as
// `needs_you` — and the words the UI uses to describe it.

import { getDb } from './db.js'
import { emitConversationEvent, emitGlobalEvent } from './sse.js'
import { setRunWaiting, finishRun } from './runs.js'
import type { PendingQuestion } from './types.js'

export function getPendingQuestion(conversationId: string): PendingQuestion | null {
  const row = getDb()
    .prepare('SELECT pending_question FROM conversations WHERE id = ?')
    .get(conversationId) as { pending_question: string | null } | undefined
  return parsePending(row?.pending_question ?? null)
}

export function parsePending(raw: string | null): PendingQuestion | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as PendingQuestion
  } catch {
    return null
  }
}

/**
 * Record (or, with null, clear) what the conversation waits on, and tell every
 * screen that shows it: the chat (its own channel), Today and the sidebar (the
 * global one — with the payload, so the list of conversations already loaded
 * can be patched rather than refetched). The run follows: `needs_you` while a
 * question is open, back to `running` when it closes.
 */
export function setPendingQuestion(conversationId: string, question: PendingQuestion | null): void {
  const previous = getPendingQuestion(conversationId)
  getDb()
    .prepare('UPDATE conversations SET pending_question = ? WHERE id = ?')
    .run(question ? JSON.stringify(question) : null, conversationId)
  const runId = question?.run_id ?? previous?.run_id
  if (runId) setRunWaiting(runId, question !== null)
  emitConversationEvent(conversationId, { type: 'question', question })
  emitGlobalEvent({ type: 'question', conversation_id: conversationId, question })
}

/**
 * The prompt can no longer be answered: forget it and close the run as lost.
 *
 * Called when the engine answers 404 to an answer — its session is gone. There
 * is deliberately no boot-time sweep of parked questions: a backend restart
 * re-attaches to the engine's live sessions and their replay re-raises what is
 * still open, and an engine restart ends the stream, which clears its
 * questions. Only both restarting at once leaves a card behind, and the first
 * click on it lands here with an honest message — better than a sweep that
 * would also tear down cards on an instance whose engine holds nothing, which
 * is exactly what the seeded fixtures are.
 */
export function dropPendingQuestion(conversationId: string, q: PendingQuestion | null): void {
  if (q?.run_id) {
    finishRun(q.run_id, 'interrupted', { error: 'The session waiting for an answer is gone' })
  }
  setPendingQuestion(conversationId, null)
}

// ── Words ────────────────────────────────────────────────────────────────────

interface AskQuestion {
  question?: string
  header?: string
  options?: { label?: string; description?: string }[]
  multiSelect?: boolean
}

/** The questions of an AskUserQuestion input, or an empty list for any other tool. */
export function questionsOf(q: Pick<PendingQuestion, 'tool_name' | 'input'>): AskQuestion[] {
  if (q.tool_name !== 'AskUserQuestion') return []
  const list = (q.input as { questions?: unknown }).questions
  return Array.isArray(list) ? (list as AskQuestion[]) : []
}

/**
 * One line saying what is being waited on — for the transcript note, the push
 * notification and the run's summary. A question is quoted; a tool call is
 * named with its command or its first argument.
 */
export function describePending(q: Pick<PendingQuestion, 'tool_name' | 'input'>): string {
  const questions = questionsOf(q)
  if (questions.length) {
    return questions.map((x) => x.question?.trim() || 'a question').join(' · ')
  }
  const input = q.input as Record<string, unknown>
  const detail =
    typeof input.description === 'string' ? input.description
    : typeof input.command === 'string' ? input.command
    : typeof input.file_path === 'string' ? input.file_path
    : typeof input.url === 'string' ? input.url
    : ''
  const name = q.tool_name.replace(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/, '$1: $2').replace(/_/g, ' ')
  return detail ? `Approve ${name}: ${detail.slice(0, 160)}` : `Approve ${name}`
}
