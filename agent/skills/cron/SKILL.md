---
name: cron
description: Manage scheduled tasks and reminders. Use when the user mentions crons, scheduled tasks, timers, or reminders.
allowed-tools: Bash, Read
---

# Cron Skill

Manage scheduled tasks (crons) via the internal API using `curl`. In the
interface a cron is a **routine** that runs on a schedule (page `/routines`; the
⟳ control in a chat's title bar lists the ones reporting there).

Every routine runs in its own **thread** — a conversation hidden from the chat
list, where each run happens in a fresh session. If the routine is attached to a
chat (`conversation_id`), each run leaves a report there: the answer when it had
something to say, a silent line when it opened with `[quiet]`. Unattached, the
thread shows in the sidebar's Threads group when a run is worth seeing. A cron
attached to a chat filed under a topic runs with that topic's brief.

## API

All requests use:
```
Host: ${BACKEND_URL}
Header: X-Internal-Secret: ${INTERNAL_SECRET}
Header: Content-Type: application/json
```

---

## List crons

```bash
curl -s ${BACKEND_URL}/internal/crons \
  -H "X-Internal-Secret: $INTERNAL_SECRET"
```

Returns an array of cron objects.

---

## Create or update a cron (upsert by name)

```bash
curl -s -X POST ${BACKEND_URL}/internal/crons \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: $INTERNAL_SECRET" \
  -d '{
    "name": "<unique-name>",
    "schedule": "<cron-expression>",
    "prompt": "<prompt sent to the agent when cron fires>",
    "enabled": true,
    "once": false,
    "conversation_id": "'"$JARVIS_CONVERSATION_ID"'"
  }'
```

If a cron with the same `name` exists, it is updated.

**Important — attaching to a chat:**

- **If `$JARVIS_CONVERSATION_ID` is set** (you're creating the cron from inside a chat), include `"conversation_id": "'"$JARVIS_CONVERSATION_ID"'"` so the cron reports into the current chat — unless the user explicitly asks for another chat or none.
- **If `$JARVIS_CONVERSATION_ID` is empty**, omit `conversation_id` — the routine's thread stands alone.

Check before building the payload:
```bash
echo "$JARVIS_CONVERSATION_ID"  # empty → omit field; set → include it
```

---

## Delete a cron by name

```bash
curl -s -X DELETE "${BACKEND_URL}/internal/crons/<name>" \
  -H "X-Internal-Secret: $INTERNAL_SECRET"
```

---

## Fields

- `name` (string, required) — unique identifier, kebab-case (e.g. `daily-brief`, `weekly-review`)
- `schedule` (string, required) — cron expression (5 fields, validated by node-cron)
- `prompt` (string, required) — the prompt executed by the agent when the cron fires
- `enabled` (boolean, default true) — toggle on/off without deleting
- `once` (boolean, default false) — fires once then auto-deletes. Not offered in the UI: set it yourself for reminders and one-off tasks, and unset it if a one-off turns into a recurring job.
- `conversation_id` (string, optional) — the chat the runs report into. Use `$JARVIS_CONVERSATION_ID` to target the current chat.

## Cron expression examples

- Every day at 7am: `0 7 * * *`
- Every Monday at 9am: `0 9 * * 1`
- Every 15 minutes: `*/15 * * * *`
- First of every month at midnight: `0 0 1 * *`

Timezone is read from the `TZ` environment variable (defaults to UTC). Check `$TZ` in bash when computing times.

---

## Behavior

- Runs happen in the routine's thread (created with the routine, reused by every run). Each run starts a fresh session; replying in the thread continues the latest run.
- With `conversation_id`, each finished run posts a report into that chat. A run whose answer opens with `[quiet]` reports as a silent line: no badge, no notification. Write prompts so the run says `[quiet]` when there is nothing new.
- If the attached chat is deleted, the thread stands alone from then on.
- The cron prompt is NOT shown as a user message.
- `once: true` crons fire once then delete themselves — use for reminders and one-off tasks
- The prompt is executed by the agent with full tool access (web search, files, etc.)

## Typical flow

1. List existing crons first to see what's already scheduled.
2. Pick a descriptive kebab-case `name`.
3. Check `$JARVIS_CONVERSATION_ID` — if set, include it as `conversation_id`; if empty, omit the field.
4. For reminders: compute the exact cron minute/hour from the user's request (use `$TZ`) and set `once: true`.
5. Always confirm what was created/updated/deleted by showing the API response.
