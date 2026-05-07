---
name: slack
description: Send and read Slack messages as the user. Use when the user mentions Slack, channels, DMs, or asks to send/read Slack messages.
allowed-tools: Bash, Read, Write
---

# Slack Skill

Post and read Slack messages using a **User OAuth Token** (messages appear as the user, not a bot).

## Credentials

- **Token:** `${SLACK_USER_TOKEN}` (starts with `xoxp-`)
- **API base:** `https://slack.com/api/`

All methods are HTTP POST with `Authorization: Bearer ${SLACK_USER_TOKEN}`.

---

## Send a message

```bash
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer ${SLACK_USER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"channel": "CHANNEL_ID", "text": "Hello from Jarvis"}'
```

- Use a **channel ID** (e.g. `C0123ABCDEF`), not the channel name.
- To find the channel ID, list channels first (see below).

---

## List channels

```bash
curl -s https://slack.com/api/conversations.list \
  -H "Authorization: Bearer ${SLACK_USER_TOKEN}" \
  -d "types=public_channel,private_channel&limit=100"
```

Returns `channels[]` with `id`, `name`, `is_member`, etc.

---

## Read channel history

```bash
curl -s https://slack.com/api/conversations.history \
  -H "Authorization: Bearer ${SLACK_USER_TOKEN}" \
  -d "channel=CHANNEL_ID&limit=20"
```

Returns `messages[]` with `text`, `user`, `ts`, etc.

---

## Send a DM

First, open a DM channel with the user:

```bash
curl -s -X POST https://slack.com/api/conversations.open \
  -H "Authorization: Bearer ${SLACK_USER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"users": "USER_ID"}'
```

Then send a message to the returned `channel.id`.

---

## Look up users

```bash
curl -s https://slack.com/api/users.list \
  -H "Authorization: Bearer ${SLACK_USER_TOKEN}" \
  -d "limit=200"
```

Returns `members[]` with `id`, `name`, `real_name`, `profile.email`, etc.

---

## Common use cases

| Task | API method |
|---|---|
| Post to a channel | `chat.postMessage` |
| Read recent messages | `conversations.history` |
| List channels | `conversations.list` |
| Send a DM | `conversations.open` + `chat.postMessage` |
| List users | `users.list` |
| Reply in thread | `chat.postMessage` with `thread_ts` |
| React to a message | `reactions.add` with `channel`, `name`, `timestamp` |

## Notes

- Always use channel IDs, not names, in API calls.
- For paginated results, use the `cursor` field from `response_metadata.next_cursor`.
- Rate limits: Slack allows ~1 req/sec for most methods. Avoid tight loops.
- The user token posts **as the user** — messages show their name and avatar.
