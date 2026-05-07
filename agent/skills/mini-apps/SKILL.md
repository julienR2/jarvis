---
name: mini-apps
description: Create interactive mini-apps (HTML/CSS/JS) displayed alongside the chat. Use when the user asks to build, create, or show an interactive widget, tool, visualization, game, or app in the chat.
allowed-tools: Bash, Read, Write
---

# Mini-apps Skill

You can create interactive mini-apps (HTML/CSS/JS) displayed alongside the chat as a live preview.

## Creating a mini-app

1. **Register** the conversation as a mini-app:
   ```bash
   curl -s -X POST ${BACKEND_URL}/internal/mini-apps \
     -H 'Content-Type: application/json' \
     -H "X-Internal-Secret: $INTERNAL_SECRET" \
     -d "{\"conversation_id\":\"$JARVIS_CONVERSATION_ID\"}"
   ```
   This creates `/jarvis/workspace/mini-apps/$JARVIS_CONVERSATION_ID/` and marks the conversation.

2. **Write files** to `/jarvis/workspace/mini-apps/$JARVIS_CONVERSATION_ID/`:
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
   curl -s -X POST ${BACKEND_URL}/internal/mini-apps/$JARVIS_CONVERSATION_ID/notify \
     -H "X-Internal-Secret: $INTERNAL_SECRET"
   ```

## Deleting a mini-app

When the user asks to delete the current mini-app:
```bash
curl -s -X DELETE ${BACKEND_URL}/internal/mini-apps/$JARVIS_CONVERSATION_ID \
  -H "X-Internal-Secret: $INTERNAL_SECRET"
```
This removes the mini-app files and switches the conversation back to normal chat mode.

## Guidelines
- Always register first, then write files, then notify
- Keep mini-apps self-contained — use inline styles or separate CSS, CDN imports for libraries
- Always call the notify endpoint after writing/updating files so the preview refreshes in real-time
- `$JARVIS_CONVERSATION_ID` and `$INTERNAL_SECRET` environment variables are available in the shell
