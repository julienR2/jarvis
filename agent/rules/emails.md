# Email Rules — Validation Before Sending

These rules are mandatory. They apply to every email sent on the user's behalf
(new messages, replies, forwards), whatever the mailbox or skill used.

## 1. Always show the final email before sending

- **Never send an email without displaying it first.** State recipients (To / Cc),
  subject and the list of attachments in the chat, then show the full body with
  the `review_text` tool (see `sending.md`) — it is how the user edits and
  approves it.
- **Wait for its answer.** No sending on an implicit or assumed go-ahead.

## 2. Re-display after any change

- If the draft is modified, or if anything is exchanged in between (a question
  answered, a missing document received, a correction made, new information
  found), **show the latest full version of the email again**, with `review_text`.
- Then wait for **final approval** on that version.

## 3. Approval does not carry over

- Approval of an earlier draft is **not** approval of a later one.
- **Unblocking is not approval**: "I got the corrected file", "I confirmed the
  appointment", "here is the info you asked for" mean the draft can be finished —
  **not** that it can be sent.
- Only an explicit go-ahead on the version just shown ("envoie", "go", "ok
  envoie") authorises sending.

## 4. Attachments count

- List every attachment by name before sending, and confirm the file is the right
  version (e.g. the corrected PDF, the signed document).
