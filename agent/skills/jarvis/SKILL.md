---
name: self-edit
description: Modify Jarvis's own source code (frontend, backend, engine). Use ONLY when the user explicitly asks to modify Jarvis itself (e.g. "improve your interface", "work on Jarvis", "change your chat UI", "add a feature to Jarvis"). Do NOT activate from ambiguous requests.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Self-Edit Skill — Modify Jarvis

You can edit Jarvis's own source. Two facts shape how:

1. **Nothing you save is live in prod.** Prod runs without file watchers. A
   change reaches the instance the user is talking to only when the `deploy`
   skill runs, after they have approved it.
2. **The `next` stack shows edits live.** It is the same tree in dev mode, on
   throwaway data, served at `/next/` on the same origin (prod's frontend
   proxies it). Point the chat's app pane there and the user watches the change
   happen beside the conversation — no reload, no second login.

   It runs as part of the normal stack (compose profile `next`, enabled from
   `.env`). Reach it from here as `next-backend:3005`; a 502 or a refused
   connection means the profile is off — say so, don't deploy to compensate.

## The loop

1. Explore with `Glob`/`Grep`, read before editing, follow existing patterns.
2. Edit. Typecheck: `npm --prefix /jarvis/frontend run typecheck` and/or
   `npm --prefix /jarvis/backend run typecheck`.
3. **Show it on next.** Check the stack is up (`curl -s http://next-backend:3005/health`).
   If it is, put the page you touched in the app pane (the iframe path is what
   the user's browser resolves, so it is `/next/...`, not a container name):
   ```bash
   mkdir -p "$WORKSPACE_DIR/apps/$JARVIS_CONVERSATION_ID"
   cat > "$WORKSPACE_DIR/apps/$JARVIS_CONVERSATION_ID/index.html" <<HTML
   <!doctype html><html><body style="margin:0"><iframe src="/next/crons" allow="microphone" style="border:0;width:100%;height:100vh"></iframe></body></html>
   HTML
   curl -s -X POST "$BACKEND_URL/internal/apps" -H 'Content-Type: application/json' -H "X-Internal-Secret: $INTERNAL_SECRET" -d "{\"conversation_id\":\"$JARVIS_CONVERSATION_ID\"}"
   curl -s -X POST "$BACKEND_URL/internal/apps/$JARVIS_CONVERSATION_ID/notify" -H "X-Internal-Secret: $INTERNAL_SECRET"
   ```
   Replace `/next/crons` with the route being changed (`/next/` for the chat
   itself, `/next/c/<id>` for a fixture conversation, `/next/settings`…).
   Register once per conversation; later edits appear on their own through HMR.
   If next is down, say so and describe the change instead — do not deploy to
   show it.
4. The user looks and says yes, or asks for more. Iterate in step 2.
5. On approval: commit (multi-file changes wait for this review), then run the
   **`deploy` skill**. The prod tab then shows the reload banner.

Next's data is fixtures, not the user's: sections "🧪 Fixtures / ☀️ Daily /
🏗️ Projects", a markdown showcase, an activity conversation, a morning-brief
run, a fixture app, a disabled cron, a webhook, an API key. `POST
http://next-backend:3005/internal/reset` (same secret) wipes and reseeds it if
a test made a mess.

**Logging in to next yourself** (for a screenshot or an e2e run): the seed
creates `e2e@jarvis.local` with a random password, kept in
`/jarvis/agent/next/data/e2e-credentials.json` (regenerated on every reseed).
```bash
TOK=$(curl -s -X POST http://next-backend:3005/api/auth/login -H 'Content-Type: application/json' \
  -d "$(cat /jarvis/agent/next/data/e2e-credentials.json)" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```
Then in Playwright: open `/next/login` on `http://jarvis-frontend:5173`, set
`localStorage.token`, navigate to `/next/`. That token is refused by prod on
purpose — prod only honours sessions for accounts that exist in its own DB. Never
paste it into a tool call; hand it to the browser through a file or a request.

## When to use this skill

**ONLY** when the user explicitly asks to modify Jarvis itself. Look for clear intent like:
- "Let's improve your interface"
- "Let's work on Jarvis"
- "Change your chat UI"
- "Add a feature to Jarvis"

**DO NOT** activate this skill if the user is talking about something else that happens to mention UI, files, or code. When in doubt, ask: "Do you want me to modify Jarvis's own interface?"

## Frontend source location

The source is mounted at `/jarvis/frontend/` inside the container.

```
/jarvis/frontend/
├── src/
│   ├── components/    # React components (ChatView, ChatInput, Sidebar, etc.)
│   ├── pages/         # Page components (ChatPage, LoginPage, etc.)
│   ├── api.ts         # API client and SSE connection
│   ├── App.tsx        # Router and layout
│   └── main.tsx       # Entry point
├── index.html
├── tailwind.config.js
└── vite.config.ts
```

**Tech stack**: React 19, TypeScript, Tailwind CSS 4, React Router v7, Lucide icons, react-markdown.

## How to make changes

1. Use `Glob` and `Grep` to explore the codebase and understand existing patterns
2. Read the relevant files before editing — understand the existing code first
3. Use `Edit` for targeted changes, `Write` only for new files
4. Typecheck (`npm --prefix /jarvis/frontend run typecheck`), show the user the diff, and when they approve, run the `deploy` skill

## Telling the user to reload

There is **no hot reload**, and no build until you deploy. The container serves
a fixed production build behind `vite preview`; the `deploy` skill replaces it.
Until the tab reloads after that, the user is looking at the old interface and
your change appears to have done nothing.

When the deploy lands, a **"Jarvis updated its interface" banner with a Reload
button** appears at the bottom of their screen automatically. So:

- **Finish by telling them to reload**, e.g. "Reload to see it — use the Reload
  button in the banner at the bottom, or the ↻ button at the bottom of the sidebar."
- The banner appears once the deploy has swapped the build in; there is nothing
  to wait for after the script returns.
- If they say the change isn't showing, the first question is always whether
  they reloaded.

## Important guidelines

- **Follow existing patterns** — match the code style, component structure, and naming conventions already in use
- **Small, incremental changes** — make one change at a time so the user can review each one after a reload
- **Don't break things** — if you're unsure about a change, explain what you plan to do and ask before editing
- **Backend and engine too** — same loop. A backend change shows on next once
  its `tsx watch` reloads (a second); an engine change needs next's engine
  restarted, which needs the host (`docker compose restart next-engine`) — say
  so rather than pretending it is visible
- **Explain what you changed** — after each edit, briefly tell the user what you modified, what they should see, and that they need to reload
