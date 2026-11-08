---
name: apps
description: Build apps that live beside a chat — dashboards, games, tools, experiments, small sites or pages to share — as HTML/CSS/JS in the chat's side pane, and show documents (a spec, a plan, a report, a PDF) or links there as tabs. Use when the user asks for an app, a dashboard, a widget, a game, a visualization, a page or site, or "something I can open/click", when a dossier or project would be easier to follow as a dashboard, and when a document you wrote is the deliverable and belongs beside the chat.
allowed-tools: Bash, Read, Write, Edit
---

# Apps and the side pane

A chat has a **side pane**. It can hold the chat's **app** — a folder of static
HTML/CSS/JS served in a frame — and **tabs**: documents rendered beside the chat,
and links. On desktop it sits next to the chat (the Chat / App toggle in the
title bar); on the phone it is a full-screen view of its own.

An app often becomes the chat's front door: Finances, Todos, a dossier's
dashboard are opened for the app, and the chat is where it gets changed.

## What an app is good for

- **Dashboards** over data you can fetch or compute: a dossier's state (dates,
  amounts, what is waiting on whom), finances, a project's progress.
- **Tools** the user comes back to: a todo list, bookmarks, a scratchpad, a drive browser.
- **Games and experiments**: anything playable or explorable.
- **Pages to share**: a memorial site, a photo story, a trip plan — the share
  link opens it with no account.

Offer one when the user keeps asking the same question of the same data, or a
dossier has grown past what a chat can show at a glance. Don't build one for a
single answer; a table in the chat is enough.

## Creating and updating an app

```bash
# 1. Register: creates $WORKSPACE_DIR/apps/$JARVIS_CONVERSATION_ID/ and marks the chat
curl -s -X POST "$BACKEND_URL/internal/apps" -H "X-Internal-Secret: $INTERNAL_SECRET" \
  -H 'Content-Type: application/json' -d "{\"conversation_id\":\"$JARVIS_CONVERSATION_ID\"}"

# 2. Write index.html (required) and whatever else, into that folder

# 3. Refresh the preview — after every write
curl -s -X POST "$BACKEND_URL/internal/apps/$JARVIS_CONVERSATION_ID/notify" -H "X-Internal-Secret: $INTERNAL_SECRET"
```

The chat's app folder is `apps/<slug>`, where the slug is in the chat's
`app_path` (`GET /internal/conversations/$JARVIS_CONVERSATION_ID`). Most are the
chat's id; some older ones have a name (`apps/todos`, `apps/drive`). Edit the
one the chat points at.

**Delete** only when asked: `DELETE /internal/apps/$JARVIS_CONVERSATION_ID` archives
the folder to `apps-archive/` (recoverable) and turns the chat back into a plain chat.

## How to build it

- **Static only.** The backend serves the folder's files and nothing else: no
  server code, no routes, no ports. For React and libraries, use ES modules from
  a CDN (`<script type="importmap">` with `https://esm.sh/react@18`, …).
- **Data in a file, refreshed by a routine.** Fetch or compute it ahead of time
  into `data.json` beside `index.html` (a small `generate.py` in the folder is the
  usual shape), and load it client-side. When it must stay fresh, a cron in the
  `routines` skill re-runs the generator and calls notify. For a dossier, the
  run that updates the dossier updates its dashboard too.
- **Built for both sizes**: a ~40%-wide pane beside the chat on desktop, the
  whole screen on a phone. Test the narrow layout first.
- **Keep the folder light.** It is served whole, and archived whole on delete.
  Photos, videos and archives belong on the drive (CopyParty), loaded through the
  connector proxy below — not copied in by the hundred megabytes.
- `localStorage` is shared with the Jarvis UI: prefix every key with the app's
  name (`todos-filter`, never `filter`), and **never read `token`** — that is
  the user's whole account session.

## Reaching data and Jarvis from an app

**A connector** (CopyParty, any service with a proxy configured): through
`/api/connectors/<id>/proxy/…`, authenticated with the app's own token, which is
in the URL the app is opened with. It can proxy through connectors and nothing
else, and the user can rotate it per app.

```js
const APP_TOKEN = new URLSearchParams(location.search).get('token') || ''
const auth = () => (APP_TOKEN ? { Authorization: `Bearer ${APP_TOKEN}` } : {})
const res = await fetch('/api/connectors/copyparty/proxy/notes/', { headers: auth() })   // GET, PUT, POST, DELETE
```

**Jarvis itself** (a button that asks something, a form that files a note): a
webhook with its own narrow prompt (`routines` skill), called from the app with
`fetch('/api/hooks/<token>/trigger?sync=1', {method: 'POST', body: JSON.stringify(payload)})`
— `sync=1` returns the answer as `response`. Know the cost: the token sits in
the app's source, so anyone holding the app's share link can call that webhook.
Keep such a webhook's prompt narrow (it acts on the payload, nothing else), and
say so when the app is shared.

**Shares from the phone**: an app that handles `jarvis:share-intent` messages
is offered in the share sheet, and receives what was shared:

```js
window.addEventListener('message', (e) => {
  if (e.data?.type !== 'jarvis:share-intent') return
  const { title, text, url, files } = e.data   // files: [{ name, type, dataUrl }]
})
```

Jarvis looks for the literal string `jarvis:share-intent` in the app's code to
decide; keep it written out. Give visual feedback when a share lands.

## Documents and links as tabs

When a document you wrote **is the deliverable** — a spec, a plan, a report, a
draft you will iterate on together — open it beside the chat rather than pasting
it into the answer:

```bash
curl -s -X POST "$BACKEND_URL/internal/conversations/$JARVIS_CONVERSATION_ID/tabs" \
  -H "X-Internal-Secret: $INTERNAL_SECRET" -H 'Content-Type: application/json' \
  -d '{"path": "/jarvis/agent/workspace/uploads/<conversation-id>/spec.md"}'
#  or {"url": "https://…"} for a page;  "title": "…" to name the tab;  "pin": true to keep it
```

- The tab **points at the file**; it does not copy it. Keep editing the file with
  your usual tools: the pane re-renders on every save, while the user watches.
- Unpinned, it is the chat's **temporary tab**, replaced by the next one you open.
  That is the default: open freely, nothing piles up. `pin: true` only for a
  document the chat will live with (the dossier's state, the project spec); the
  user can pin or close any tab themselves.
- **Where the file lives decides who sees it**: in the chat's uploads folder it
  is this chat's; under `$WORKSPACE_DIR/memory/…` or in the repo (`/jarvis/docs/…`)
  any chat can open the same one — the right place for a document a topic shares.
- Renders: Markdown (`.md`), text (`.txt .csv .json .yml .log`), PDF, HTML
  (sandboxed, no scripts — interactive pages are apps), images. Up to 5 MB. Paths
  under the workspace or the repo, not `agent/` outside the workspace.
- On the phone the tab opens but the view stays on the chat, so **also link the
  file in your answer** (`[spec.md](/jarvis/agent/workspace/uploads/<id>/spec.md)`):
  a tap on such a link opens it in the pane, on any device.
- Not for: a short answer, a file the user only needs to download, every file
  you touch along the way.

`GET …/tabs` lists a chat's tabs; `DELETE …/tabs/<tab id>` closes one.

A **link tab** frames a web page beside the chat. Many sites refuse to be
framed; the pane then offers to open it in a new browser tab. Use it for a page
the user works with alongside the chat (a dashboard, a doc, a map), not for every
URL you cite.
