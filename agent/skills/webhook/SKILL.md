---
name: webhook
description: Manage webhooks and HTTP-triggered automations. Use when the user mentions webhooks, HTTP triggers, or external integrations that should trigger the agent on demand.
allowed-tools: Bash, Read
---

# Webhook Skill

Manage webhooks (HTTP-triggered automations) via the internal API using `curl`.

## API

All requests use:
```
Host: ${BACKEND_URL}
Header: X-Internal-Secret: ${INTERNAL_SECRET}
Header: Content-Type: application/json
```

---

## List webhooks

```bash
curl -s ${BACKEND_URL}/internal/webhooks \
  -H "X-Internal-Secret: $INTERNAL_SECRET"
```

Returns an array of webhook objects.

---

## Create or update a webhook (upsert by name)

```bash
curl -s -X POST ${BACKEND_URL}/internal/webhooks \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: $INTERNAL_SECRET" \
  -d '{
    "name": "<unique-name>",
    "prompt": "<prompt sent to the agent when webhook is triggered>",
    "enabled": true,
    "conversation_id": "'"$JARVIS_CONVERSATION_ID"'"
  }'
```

If a webhook with the same `name` exists, it is updated (token is preserved).

**Important:** Always include `"conversation_id": "'"$JARVIS_CONVERSATION_ID"'"` so the webhook posts its responses in the current chat. If the conversation no longer exists when the webhook fires, a new one is created automatically.

---

## Delete a webhook by name

```bash
curl -s -X DELETE "${BACKEND_URL}/internal/webhooks/<name>" \
  -H "X-Internal-Secret: $INTERNAL_SECRET"
```

---

## Fields

- `name` (string, required) — unique identifier, kebab-case (e.g. `email-processor`, `deploy-notifier`)
- `prompt` (string, required) — the prompt executed by the agent when triggered
- `enabled` (boolean, default true) — toggle on/off without deleting
- `conversation_id` (string, optional) — link the webhook to an existing conversation so responses appear there. Use `$JARVIS_CONVERSATION_ID` to target the current chat.

---

## Trigger URL

Each webhook gets a unique token (UUID). The public trigger URL is:

```
POST /api/hooks/<token>/trigger
```

- No authentication needed — the token in the URL IS the auth
- Accepts an optional JSON body (`payload`) which gets appended to the prompt
- The token is shown in the API response when the webhook is created

Example trigger from an external system (e.g. n8n):

```bash
curl -X POST https://jarvis.example.com/api/hooks/<token>/trigger \
  -H "Content-Type: application/json" \
  -d '{"subject": "Meeting tomorrow", "from": "boss@example.com", "body": "..."}'
```

The payload JSON will be appended to the prompt as:
```
Webhook payload:
{ ... }
```

---

## Behavior

- If `conversation_id` is set, the webhook posts responses in that conversation. If the conversation no longer exists, a new one is created.
- If no `conversation_id` is set, a new conversation is auto-created on first trigger and reused after.
- The webhook prompt is NOT shown as a user message — only the assistant response appears in the chat.
- The prompt is executed by the agent with full tool access (web search, files, etc.)

## Typical flow

1. List existing webhooks first to see what's already configured.
2. Pick a descriptive kebab-case `name`.
3. Create the webhook and note the `token` from the response.
4. Configure the external system (n8n, etc.) to POST to `/api/hooks/<token>/trigger`.
5. Always confirm what was created/updated/deleted by showing the API response.
