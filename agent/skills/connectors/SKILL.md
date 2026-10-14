---
name: connectors
description: How Jarvis's connectors work — where credentials live, how to list what's configured, and how to read a connector's values on demand. Use when you need an API key / login for an external service (Gmail, GitHub, Slack, a second mailbox, etc.), when the user asks what connectors exist, or when a skill needs credentials it doesn't already have, or when acting on an app connected through One (Spotify, Calendar, …).
allowed-tools: Bash, Read
---

# Connectors Skill

A **connector** is a set of named credentials for one external service, stored in
the `connectors` table of the Jarvis DB. Each connector has:

- an **id** (slug, e.g. `gmail`, `gmail-work`, `notion`)
- a **name**, **description**, **icon**
- a list of **fields** — each a `{ label, value }` pair with a stable machine
  **key** (e.g. `GMAIL_APP_PASSWORD`)
- an optional **proxy** config (see below)

Credentials are **not** injected as environment variables. Read them on demand
from the internal API instead — this is always current and needs no restart.

## List what's configured (the live inventory)

```bash
curl -s -H "X-Internal-Secret: $INTERNAL_SECRET" "$BACKEND_URL/internal/connectors" \
  | python3 -m json.tool
```

Returns every connector with its `id`, `name`, `description`, `hasProxy`, and
field **labels + keys** (no values). Use this to discover what exists — for
example to find that the same person has a `gmail-work` **and** an `aol-personal`
mailbox configured.

Each entry has a `source`: `jarvis` for the connectors described below, `one`
for apps connected through One — see [Connections through One](#connections-through-one).

## Read one connector's values

```bash
curl -s -H "X-Internal-Secret: $INTERNAL_SECRET" "$BACKEND_URL/internal/connectors/gmail" \
  | python3 -m json.tool
```

Returns `fields` (with values) and a flat `env` map keyed by field key.

### Load its values into the shell

Shell state does **not** persist between separate commands, so run this `eval`
in the **same** command block as whatever uses the credentials:

```bash
eval "$(curl -s -H "X-Internal-Secret: $INTERNAL_SECRET" \
  "$BACKEND_URL/internal/connectors/gmail" \
  | python3 -c 'import sys,json;[print(f"export {k}={json.dumps(v)}") for k,v in json.load(sys.stdin).get("env",{}).items()]')"

# now $GMAIL_ADDRESS and $GMAIL_APP_PASSWORD are set — use them here
echo "$GMAIL_ADDRESS"
```

Each connector's own skill (gmail, github, linear, …) starts with this snippet
for its id. Connectors you added yourself, with no dedicated skill page, are
used the same way — list the inventory, then read the connector.

## Connections through One

[One](https://www.withone.ai) is a second kind of connector, plugged in from
**Settings → Customize → One**. The person signs in to an app (Gmail, Google
Calendar, Spotify, Notion, …) on One's site; the credential stays at One and
never reaches Jarvis. In the inventory those entries look like:

```json
{ "id": "one:…", "source": "one", "name": "Spotify Web", "platform": "spotify-web",
  "connectionKey": "live::spotify-web::default::…", "state": "operational" }
```

There are no values to read. Act through the `one` MCP server instead, which
is loaded in every session while One is plugged in:

1. `mcp__one__list_one_integrations` — the connected apps and their connection keys.
2. `mcp__one__find_one_actions` — find the action for each step, with its docs
   (`requests: [{ platform: "spotify-web", intent: "add a track to a playlist" }]`).
   Read the docs it returns before executing: they carry the required fields.
3. `mcp__one__execute_one_action` — run it with the `action_id` and the
   `connection_key`.

If the `mcp__one__*` tools are not there, One is not plugged in (or switched
off): say so and point to Settings → Customize → One rather than improvising.
If an app the user asks about is not connected, tell them to connect it there —
connecting takes an OAuth sign-in only they can do.

When the same service is connected both ways (a `gmail` Jarvis connector and a
Gmail One connection), a dedicated skill's instructions win; otherwise either
works — use the one the user names, or ask if it matters which account.

## Proxy

Some connectors (currently `copyparty`) carry a `proxy` config so browsers and
`<img>` tags can reach an internal-only service with auth attached by the
backend. Fetch through:

```
$BACKEND_URL/api/connectors/<id>/proxy/<path>
```

GET is unauthenticated by design (only surfaced inside JWT-gated chat/apps);
PUT/POST/DELETE need a JWT. See the `copyparty` skill for usage.

## Adding / editing a connector

Prefer the UI: **Settings → Connectors → Add connector** — name it, pick an icon
(or paste a logo image URL), then add label + value fields. Editing opens the
same modal. The machine key for each field is derived from its label
automatically; existing keys are preserved.

To do it programmatically (needs a JWT):

```bash
curl -s -X POST "$BACKEND_URL/api/connectors" -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -d '{
    "name": "My Service",
    "description": "what it is for",
    "icon": "Plug",
    "fields": [ { "label": "API key", "value": "…" } ]
  }'
# PATCH /api/connectors/:id to edit, DELETE /api/connectors/:id to remove.
```

There is **no hardcoded connector catalog** — every connector is just a DB row.

## When does a connector deserve its own skill?

- **Yes** when it has real surface to document — an auth flow, a query language,
  pagination, non-obvious endpoints, or a repeated idiom (gmail, github, linear,
  slack, pocketbase, copyparty, elevenlabs).
- **No** when it's plain REST with an obvious pattern, rarely used, or already
  covered by a domain skill that owns the whole workflow it belongs to. Those are
  reached via the inventory + read pattern above.

## People → mailboxes

Family email may be spread across several connectors, and one person can have more
than one mailbox (e.g. a Gmail **and** an AOL account). Always **check the live
inventory** (`GET /internal/connectors`) before assuming an address — if the user
names a person without naming a provider, look at every connector that could be
theirs and check each. All mailbox connectors are IMAP/SMTP, usable exactly like the
`gmail` skill's pattern. Personal person→connector mappings live in `CLAUDE.local.md`.
