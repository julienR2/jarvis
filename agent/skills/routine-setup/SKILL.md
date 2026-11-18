---
name: routine-setup
description: Change a routine from inside its own conversation, or make the current conversation a routine. Use when an `<article data-jarvis="routine-thread">` says this conversation is a routine and the user wants to change, pause, re-target or delete it — or when the user asks to turn this very chat into a routine.
allowed-tools: Bash, Read, AskUserQuestion
---

# Routine setup

A **routine** is a prompt Jarvis runs without the user: on a schedule (a cron) or
when something calls its link (a webhook). Every routine lives in a
conversation of its own where each run happens — usually you are in it now,
and the `<article data-jarvis="routine-thread">` at the top of the message gives
its current settings. (The user can also start one from the composer of an
empty chat or a new thread, with its "Every…" / "When called" pills.)

Its settings are behind a chip in the conversation's title bar. Whatever you
change through the API shows up there at once, so don't re-describe every
setting in your answer: confirm what changed in a line.

Keep the exchange short and friendly. This is setup, not a project.

## Creating one

Find out, in as few turns as possible:

1. **What it does on each run.** This becomes its prompt.
2. **When it runs.** On a schedule (get the time and days, then write the cron
   expression yourself) or when called (a webhook).
3. **Which chat it hangs under.** The `routine-thread` article says whether this
   conversation was opened from a chat. If it was, default to that chat.
   Otherwise it is a chat of its own in the sidebar.
4. **Notifications**: `auto` (the default: notify when a run has something
   worth saying), `subscribe` (always), `unsubscribe` (never).

If the user's first message already answers most of this, don't ask again.
Confirm in one line and create. Otherwise ask with **AskUserQuestion**: one call
with up to 4 questions and concrete options (e.g. "Every morning at 7",
"Weekdays at 9", "Every hour", "When called"). The user can always type their
own answer.

**Write the prompt for the run, not for the user.** It must be self-contained:
each run starts with no memory of this conversation. Say what to check, what
counts as worth reporting and what deserves a phone notification. The run is
told about the `[quiet]` / `[push: …]` markers on its own; no need to repeat them.

Pick a short kebab-case `name` (e.g. `surf-watch`). It becomes the thread's name.

### Create a cron

```bash
curl -s -X POST "$BACKEND_URL/internal/crons" \
  -H "Content-Type: application/json" -H "X-Internal-Secret: $INTERNAL_SECRET" \
  -d '{
    "name": "<name>",
    "schedule": "<cron expression>",
    "prompt": "<the run prompt>",
    "thread_id": "'"$JARVIS_CONVERSATION_ID"'",
    "conversation_id": "<the chat id from the routine-thread article, or omit>",
    "notify": "auto"
  }'
```

The timezone is `$TZ`. Set `"once": true` for a one-off reminder: it fires once,
then deletes itself.

### Create a webhook

Same call against `$BACKEND_URL/internal/webhooks`, without `schedule`. Its
link (where to POST, with an optional JSON body handed to the prompt) shows on
the routine's bar at the top of this thread. Point the user there.

Always pass `"thread_id": "'"$JARVIS_CONVERSATION_ID"'"`, so the routine runs in
**this** thread rather than opening another one.

After creating it, say in two lines what it will do and when, and offer to run
it once now so they can see a first result:

```bash
curl -s -X POST "$BACKEND_URL/internal/crons/<id>/trigger" -H "X-Internal-Secret: $INTERNAL_SECRET"
```

(`/internal/webhooks/<id>/trigger` for a webhook.)

## Changing one

The `routine-thread` article holds the current settings, including the `id`.
Ask what to change if the user hasn't said. Then send only what changes, by `id`
(this is also how you rename it):

```bash
curl -s -X POST "$BACKEND_URL/internal/crons" \
  -H "Content-Type: application/json" -H "X-Internal-Secret: $INTERNAL_SECRET" \
  -d '{"id": "<id>", "schedule": "0 8 * * 1-5"}'
```

- Pause or resume: `"enabled": false` / `true`
- Report into a chat: `"conversation_id": "<chat id>"`. Stand alone: `"conversation_id": null`
- Notifications (standing alone only): `"notify": "auto" | "subscribe" | "unsubscribe"`
- Prompt: `"prompt": "..."`. Rewrite it whole.
- Model or effort: `"model": "<id>"` (`null` = default), `"effort": "high"`.

Every field, the webhook URL (`?sync=1`, payloads) and which mechanism fits
which need: the `routines` skill.

To find the chat to hang it under (most recent first, with topics):
`curl -s -H "X-Internal-Secret: $INTERNAL_SECRET" "$BACKEND_URL/internal/conversations?limit=50"`.

Delete, only when asked explicitly: `curl -s -X DELETE "$BACKEND_URL/internal/crons/<name>" -H "X-Internal-Secret: $INTERNAL_SECRET"`.
Its conversation and history stay, as an ordinary chat.

Confirm each change in one line.
