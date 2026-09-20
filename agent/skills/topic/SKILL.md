---
name: topic
description: Read and update the shared brief of the topic a chat is filed under. Use when a chat belongs to a topic and something durable was decided or learned, when the user asks what the topic knows, or when asked to consolidate, refresh or rewrite a topic's brief.
allowed-tools: Bash, Read
---

# Topic Skill

A **topic** is a group of chats that share one **brief**: what the topic is
about, what was decided, what is open, the facts and tools that matter there.
Every chat filed under a topic starts with the brief in its prompt, and every
routine posting into one of its chats runs with it. You do not need to fetch it
to know it — if this chat is in a topic, the brief is already in front of you,
inside `<article data-jarvis="topic-context">`.

What you *do* need this skill for: **writing it back**. The brief only stays
useful if the chat where something happened updates it.

All requests use:
```
Host: ${BACKEND_URL}
Header: X-Internal-Secret: ${INTERNAL_SECRET}
```

---

## Which topic am I in?

```bash
curl -s -H "X-Internal-Secret: $INTERNAL_SECRET" \
  "$BACKEND_URL/internal/conversations/$JARVIS_CONVERSATION_ID"
```

Returns the conversation with `topic: { id, name, context, context_updated_at }`,
or `topic: null` when the chat is not filed under one. Use `topic.id` below.

## Read a topic's brief and its chats

```bash
curl -s -H "X-Internal-Secret: $INTERNAL_SECRET" "$BACKEND_URL/internal/topics/<topic-id>"
```

Returns the topic with `context` (the brief, markdown) and `conversations`
(id, title, last activity). List every topic with `GET /internal/topics`.

## Update the brief

The whole text, not a diff — re-read, rewrite, save:

```bash
cat > /tmp/brief.md <<'MD'
**What this is** — …

**Decided**
- …

**Open**
- …

**Facts**
- …

**How to work here**
- …
MD

curl -s -X PATCH "$BACKEND_URL/internal/topics/<topic-id>/context" \
  -H "X-Internal-Secret: $INTERNAL_SECRET" -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"context": open(sys.argv[1]).read()}))' /tmp/brief.md)"
```

The other chats of the topic get the new text on their next turn.

---

## When to update

- A **decision** was taken in this chat (a choice, a price, a date, a go/no-go).
- A **fact** worth having at hand next time surfaced (a name, an id, an address,
  an amount, a deadline).
- Something in the brief is now **done or wrong** — remove or fix it; a stale
  brief is worse than a short one.
- The user asks to **consolidate**, **refresh** or **rewrite** the brief: read
  the recent chats of the topic (`/internal/conversations/<id>/messages?limit=40`
  on each), then rewrite it whole.

Not for: the running commentary of a task, drafts, anything you would not want
every future chat of the topic to read first.

## How to write it

- Markdown, **under 2000 characters**. Sections only when they have content:
  *What this is* (2–3 lines) · *Decided* · *Open* · *Facts* · *How to work here*
  (skills, connectors, files, conventions).
- Terse. Dates and amounts over adjectives. No chatter, no "as of today".
- Keep what a new chat would otherwise have to be told; drop the rest.
- After saving, tell the user in one line what changed in the brief.
