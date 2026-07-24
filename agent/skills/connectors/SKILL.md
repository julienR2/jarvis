---
name: connectors
description: How Jarvis's connectors work — where credentials live, how to list what's configured, and how to read a connector's values on demand. Use when you need an API key / login for an external service (Gmail, Notion, Immich, a "papa" mailbox, etc.), when the user asks what connectors exist, or when a skill needs credentials it doesn't already have.
allowed-tools: Bash, Read
---

# Connectors Skill

A **connector** is a set of named credentials for one external service, stored in
the `connectors` table of the Jarvis DB. Each connector has:

- an **id** (slug, e.g. `gmail`, `gmail-papa`, `notion`)
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
example to find that there's a `gmail-papa` **and** an `aol-papa` mailbox.

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
for its id. Skills without a dedicated page (notion, immich, fathom, the papa
mailboxes) are used the same way — list the inventory, then read the connector.

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
  slack, pocketbase, copyparty, elevenlabs, imagerouter).
- **No** when it's plain REST with an obvious pattern, rarely used, or already
  covered by a domain skill (e.g. `example` covers `example-cms`, `example-skill`
  covers `racketid`). Those are reached via the inventory + read pattern above.

## People → mailboxes

Julien's family email is spread across connectors — check the inventory before
assuming. Notably:

- **"papa" / Alain's email**: `gmail-papa` (`person@example.com`) **and**
  `aol-papa` (`other@example.com`). Both are IMAP/SMTP mailboxes usable exactly
  like the `gmail` skill's pattern — load the connector, then connect over IMAP.
  If the user says "get papa's email" without naming the provider, check both.
