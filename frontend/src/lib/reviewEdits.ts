/**
 * What the person typed into a draft under review (review_text), by prompt.
 *
 * Kept in localStorage so a half-edited email survives a reload, another chat
 * opened, or the phone's editor closed — on this device only; the draft itself
 * (Jarvis's version) is the conversation's pending question, on every device.
 * Forgotten once the review is answered, whichever way.
 */
const PREFIX = 'review-edit:'

export function getReviewEdit(requestId: string): string | null {
  try {
    return localStorage.getItem(PREFIX + requestId)
  } catch {
    return null
  }
}

export function setReviewEdit(requestId: string, text: string): void {
  try {
    localStorage.setItem(PREFIX + requestId, text)
  } catch {
    // Full or blocked storage only costs the edit a reload.
  }
}

export function clearReviewEdit(requestId: string): void {
  try {
    localStorage.removeItem(PREFIX + requestId)
  } catch {
    // Nothing to clear.
  }
}
