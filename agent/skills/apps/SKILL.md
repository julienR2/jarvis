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
   This creates `/jarvis/workspace/apps/$JARVIS_CONVERSATION_ID/` and marks the conversation.

2. **Write files** to `/jarvis/workspace/apps/$JARVIS_CONVERSATION_ID/`:
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
This removes the app files and switches the conversation back to normal chat mode.

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

## Guidelines
- Always register first, then write files, then notify
- Keep apps self-contained — use inline styles or separate CSS, CDN imports for libraries
- Always call the notify endpoint after writing/updating files so the preview refreshes in real-time
- `$JARVIS_CONVERSATION_ID` and `$INTERNAL_SECRET` environment variables are available in the shell
