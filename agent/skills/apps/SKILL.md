---
name: apps
description: Create interactive apps (HTML/CSS/JS) displayed alongside the chat. Use when the user asks to build, create, or show an interactive widget, tool, visualization, game, or app in the chat.
allowed-tools: Bash, Read, Write
---

# Apps Skill

You can create interactive apps (HTML/CSS/JS) displayed alongside the chat as a live preview.

## Creating an app

1. **Register** the conversation as an app:
   ```bash
   curl -s -X POST ${BACKEND_URL}/internal/apps \
     -H 'Content-Type: application/json' \
     -H "X-Internal-Secret: $INTERNAL_SECRET" \
     -d "{\"conversation_id\":\"$JARVIS_CONVERSATION_ID\"}"
   ```
   This creates `$WORKSPACE_DIR/apps/$JARVIS_CONVERSATION_ID/` and marks the conversation.

2. **Write files** to `$WORKSPACE_DIR/apps/$JARVIS_CONVERSATION_ID/`:
   - `index.html` (required) — the entry point
   - Optional: separate CSS, JS, images, etc.
   - For React apps, use CDN imports:
     ```html
     <script type="importmap">
     { "imports": { "react": "https://esm.sh/react@18", "react-dom/client": "https://esm.sh/react-dom@18/client" } }
     </script>
     ```

3. **Notify** the frontend to refresh the preview after each write:
   ```bash
   curl -s -X POST ${BACKEND_URL}/internal/apps/$JARVIS_CONVERSATION_ID/notify \
     -H "X-Internal-Secret: $INTERNAL_SECRET"
   ```

## Deleting an app

When the user asks to delete the current app:
```bash
curl -s -X DELETE ${BACKEND_URL}/internal/apps/$JARVIS_CONVERSATION_ID \
  -H "X-Internal-Secret: $INTERNAL_SECRET"
```
This archives the app files (moved to `apps-archive/<conversation_id>/`, recoverable from the file browser) and switches the conversation back to normal chat mode.

## Receiving share intents

Users can share text, URLs, or files (images, PDFs, etc.) from other Android apps directly to an app via the PWA share target. To opt in, add a `message` event listener:

```js
window.addEventListener('message', (e) => {
  if (e.data?.type !== 'jarvis:share-intent') return

  const { title, text, url, files } = e.data
  // title: string — share title (often empty)
  // text:  string — shared text content
  // url:   string — shared URL
  // files: Array<{ name: string, type: string, dataUrl: string }>
  //   dataUrl is a base64 data URI — use directly as <img src> or decode for upload
})
```

Examples of what an app can do with shared data:
- **Todo app**: auto-add `text` or `url` as a new todo item
- **Storage app**: save shared `files` (images, documents) to the drive
- **Bookmarks app**: save `url` with `title` as a new bookmark

When the user shares content and picks an app from the share picker, the app opens and receives the data automatically via `postMessage`. The app should handle the intent and give visual feedback (e.g. a toast, highlight the new item).

## Calling the Jarvis API from an app

An app that needs a connector (CopyParty, a self-hosted service, anything with a
proxy configured) calls it through `/api/connectors/<id>/proxy/...`, authenticated
with **the app's own token**, which Jarvis puts in the URL the app is opened with:

```js
// Read it once at startup. Scoped to connector proxying and nothing else.
const APP_TOKEN = new URLSearchParams(location.search).get('token') || ''
const auth = () => (APP_TOKEN ? { Authorization: `Bearer ${APP_TOKEN}` } : {})

const res = await fetch('/api/connectors/copyparty/proxy/notes/', { headers: auth() })
```

Works for GET, PUT, POST and DELETE.

**Never read `localStorage` for a token.** Apps share an origin — and therefore a
`localStorage` — with the Jarvis UI, so `localStorage.getItem('token')` returns the
user's full account session: every conversation, git write access, connector
secrets, plugin installs. An app is the least trusted code in Jarvis (written from
web content, loading CDN scripts), and it must not hold that. The app token can
proxy through connectors and do nothing else, and the user can rotate it per app.

For the same reason, **prefix any `localStorage` key you do use with the app's own
name** (`drive-sort`, not `sort`). The namespace is shared with the Jarvis UI:
writing `token` or `jarvis-theme` will log the user out or corrupt their theme.

## Guidelines
- Always register first, then write files, then notify
- **Apps are frontend-only by default** — pure HTML/CSS/JS served as static assets. Do NOT add backend routes, API endpoints, or server-side code unless the user explicitly asks for a full-stack app. The backend only serves static files from the app folder; there is no support for app-specific server processes or internal ports.
- For data that comes from external APIs, prefer fetching it ahead of time into a static JSON file within the app folder, then loading it client-side. Use a cron job to keep the data fresh if needed.
- Keep apps self-contained — use inline styles or separate CSS, CDN imports for libraries
- Always call the notify endpoint after writing/updating files so the preview refreshes in real-time
- `$JARVIS_CONVERSATION_ID` and `$INTERNAL_SECRET` environment variables are available in the shell
