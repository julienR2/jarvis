---
name: cron
description: Manage scheduled tasks and reminders. Use when the user mentions crons, scheduled tasks, timers, or reminders.
allowed-tools: Bash, Read
---

# Cron Skill

Manage scheduled tasks (crons) via the internal API using `curl`.

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

**Important — conversation linking:**

- **If `$JARVIS_CONVERSATION_ID` is set** (you're creating the cron from inside a chat), always include `"conversation_id": "'"$JARVIS_CONVERSATION_ID"'"` so the cron posts its responses in the current chat — unless the user explicitly asks to target a different conversation or no conversation at all.
- **If `$JARVIS_CONVERSATION_ID` is empty** (e.g., created via the cron admin page), omit `conversation_id` entirely — a new conversation will be auto-created on first fire and reused afterwards.

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
- `once` (boolean, default false) — fires once then auto-deletes (useful for reminders)
- `conversation_id` (string, optional) — link the cron to an existing conversation so responses appear there. Use `$JARVIS_CONVERSATION_ID` to target the current chat.

## Cron expression examples

- Every day at 7am: `0 7 * * *`
- Every Monday at 9am: `0 9 * * 1`
- Every 15 minutes: `*/15 * * * *`
- First of every month at midnight: `0 0 1 * *`

Timezone is read from the `TZ` environment variable (defaults to UTC). Check `$TZ` in bash when computing times.

---

## Behavior

- If `conversation_id` is set, the cron posts responses directly in that conversation. If the conversation no longer exists, a new one is created.
- If no `conversation_id` is set, a new conversation is auto-created on first fire and reused after.
- The cron prompt is NOT shown as a user message — only the assistant response appears in the chat.
- `once: true` crons fire once then delete themselves — use for reminders and one-off tasks
- The prompt is executed by the agent with full tool access (web search, files, etc.)

## Typical flow

1. List existing crons first to see what's already scheduled.
2. Pick a descriptive kebab-case `name`.
3. Check `$JARVIS_CONVERSATION_ID` — if set, include it as `conversation_id`; if empty, omit the field.
4. For reminders: compute the exact cron minute/hour from the user's request (use `$TZ`) and set `once: true`.
5. Always confirm what was created/updated/deleted by showing the API response.
