---
name: routines
description: Create, change, list, run or delete Jarvis routines — crons (on a schedule, including one-off reminders) and webhooks (run when a URL is called by n8n, a script, the Pebble, another routine). Use when the user mentions a cron, a reminder, "every morning", "remind me at", a scheduled or recurring task, a webhook, an HTTP trigger, an automation, or wants something to run without them. Inside a routine's own thread, `routine-setup` leads the conversation; this is the API reference behind it.
allowed-tools: Bash, Read
---

# Routines — crons and webhooks

A **routine** is a prompt Jarvis runs without the user: on a schedule (**cron**)
or when its URL is called (**webhook**). The UI shows them on `/routines`, and
the ⟳ control in a chat's title bar lists those reporting into that chat.

## The model, in four facts

1. **Every routine has a thread** — a conversation of its own (`kind: thread`)
   where each run happens, in a **fresh session**. A run remembers nothing of
   earlier runs or of the chat where it was set up. So the prompt must be
   self-contained: what to check, where the context lives (a memory file, a
   CopyParty path), what counts as worth saying.
2. **It can report into a chat** (`conversation_id`). Each finished run posts its
   answer there. Every run is told, without you writing it, to open with
   `[quiet]` when there is nothing worth seeing (a silent line), or with
   `[push: <summary>]` when it is worth a phone notification. So the prompt only
   has to say **what counts** as worth reporting, and as worth a push.
3. **Unattached**, the thread stands alone and appears under the sidebar's
   Routines section when a run is worth seeing. Its `notify` mode decides push: `auto`
   (when worth it), `subscribe` (always), `unsubscribe` (never).
4. **A chat filed under a topic** passes the topic's brief to every routine
   reporting into it.

## API

Every call takes `-H "X-Internal-Secret: $INTERNAL_SECRET"` against `$BACKEND_URL`.
Crons and webhooks share the same shape; swap `crons` ↔ `webhooks`.

| | |
|---|---|
| List | `GET /internal/crons` · `GET /internal/webhooks` (webhooks include `token`) |
| Create / update | `POST /internal/crons` · `POST /internal/webhooks` — upsert, see below |
| Run now | `POST /internal/crons/<id or name>/trigger` · `POST /internal/webhooks/<id or name>/trigger` — a JSON body is the webhook's payload; `?sync=1` waits for its answer |
| Delete | `DELETE /internal/crons/<name>` · `DELETE /internal/webhooks/<name>` — by **name**; the thread and its history stay |
| Its thread | `GET /internal/conversations/<thread_id>` (includes `routine`), `…/messages` for past runs |

### Create or update

```bash
curl -s -X POST "$BACKEND_URL/internal/crons" \
  -H "Content-Type: application/json" -H "X-Internal-Secret: $INTERNAL_SECRET" \
  -d "$(python3 - <<'PY'
import json
print(json.dumps({
  "name": "surf-watch",
  "schedule": "0 7 * * *",
  "prompt": open("/tmp/prompt.md").read(),   # write long prompts to a file first
  "conversation_id": "<chat id>",            # or leave out
}))
PY
)"
```

Upsert rule: with `id` → updates that routine (the way to **rename** it); else by
`name` → updates if it exists, creates otherwise. On update, send only what
changes; what you leave out is kept. The response is `{created|updated, cron|webhook: <row>}`.

| Field | | |
|---|---|---|
| `name` | create | kebab-case, unique per kind; also the thread's name |
| `prompt` | create | the run's instructions (see fact 1) |
| `schedule` | cron, create | 5-field cron expression, in `$TZ` |
| `once` | cron | `true` = fires once then deletes itself — reminders, one-offs |
| `conversation_id` | | a **chat** id to report into; `null` detaches. A thread id is refused |
| `thread_id` | | an existing thread to become its home (used by `routine-setup`); else one is created |
| `notify` | | `auto` \| `subscribe` \| `unsubscribe` — matters when unattached |
| `enabled` | | `false` pauses without deleting |
| `model` | | a model id; `null` = the instance default. Pin a cheap one for frequent, simple runs |
| `effort` | | `high` = think hard; else the default |
| `user_message_key` | webhook | a payload field shown as the run's message in the thread (e.g. `message` for dictation) |

**Which chat?** From inside a chat, `$JARVIS_CONVERSATION_ID` is that chat —
use it unless the user names another. From inside a thread or a routine's run,
it is a thread, not a chat: find the chat with `GET /internal/conversations?limit=50`
(most recent first, with topic names) or leave `conversation_id` out.

Reminder times: compute from `date` in `$TZ`; for "in 20 minutes", schedule the
exact minute/hour/day/month with `once: true`.

### Webhook URLs

From inside Jarvis (a chat, another routine), call it by name — no token needed:

```bash
curl -s -X POST "$BACKEND_URL/internal/webhooks/<name>/trigger" \
  -H "X-Internal-Secret: $INTERNAL_SECRET" -H "Content-Type: application/json" \
  -d @payload.json
```

From outside (n8n, a script, a device), with its `token`:

```
POST https://<jarvis public host>/api/hooks/<token>/trigger
```

No other auth — the token is the secret, so don't paste it anywhere public.
Either way, a JSON body becomes the run's `Webhook payload:` appended to the prompt.
`?sync=1` waits and returns the run's answer as `response` (what the Pebble
uses); without it the call returns at once. `POST …/<token>/cancel` stops a
running run.

## Choosing the right mechanism

| The need | Use |
|---|---|
| Something at a time, or repeatedly | a cron (`once: true` for a single later moment) |
| An outside system pushes events in | a webhook, its URL given to that system |
| Hand something to **another chat now**, so it acts with its own history | `POST /internal/conversations/<id>/messages` (CLAUDE.md, *Other chats*) — not a new webhook |
| A run should hand a payload to a self-contained processing step | a webhook with its own prompt, triggered by name with the payload |
| A new subject that deserves its own chat | `POST /internal/conversations` (CLAUDE.md) |
| Just tell the user | the run's answer (reports into its chat), or `POST /internal/notify` |

Before creating, `GET` the list: a routine doing nearly the same thing may
already exist and only need its prompt or schedule changed.

## After a change

Confirm in one or two lines what it does and when, and offer to run it once now
(`…/trigger`) so they see a first result. Don't dump the API response unless
something failed.
