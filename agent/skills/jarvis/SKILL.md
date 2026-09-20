---
name: self-edit
description: Modify Jarvis's own source code (frontend, backend, engine, agent config). Use ONLY when the user explicitly asks to modify Jarvis itself (e.g. "improve your interface", "work on Jarvis", "change your chat UI", "add a feature to Jarvis"). Do NOT activate from ambiguous requests.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Self-Edit Skill — Modify Jarvis

You can edit Jarvis's own source. Three facts shape how:

1. **Nothing you save is live in prod.** Prod runs without file watchers. A
   change under `backend/`, `frontend/` or `engine/` reaches the instance the
   user is talking to only when the `deploy` skill runs, after they approved it.
   Changes under `agent/` (skills, rules, CLAUDE.md) are read at runtime by prod.
2. **The `next` stack shows edits live.** Same tree, dev mode, throwaway data,
   served at `/next/` on the same origin (prod's frontend proxies it). This is
   where you preview and QA, however big the change, without touching prod.
3. **The tree is git, and it is shared.** Other chats may be editing at the same
   time. Commit only your files, and only once the user has said yes. The
   `deploy` skill refuses a dirty tree for that reason.

You have no Docker. Everything below works from inside the engine container:
HTTP calls to the other containers, files under `/jarvis`, git, npm scripts.

## The loop

### 0. Look before you edit
```bash
cd /jarvis && git status --short && git log --oneline -3
python3 -c "import json;print(json.load(open('/jarvis/agent/data/deployed.json')))"   # what prod runs
curl -s http://next-backend:3005/health                                               # is next up?
```
A dirty tree that is not yours belongs to another chat — leave it alone and say
so if it gets in the way. `deployed.json` tells you whether HEAD is already live.

### 1. Edit
Explore with `Glob`/`Grep`, read before editing, follow existing patterns. One
change at a time. Typecheck what you touched:
```bash
npm --prefix /jarvis/frontend run typecheck
npm --prefix /jarvis/backend run typecheck
/jarvis/engine/node_modules/.bin/tsc --noEmit -p /jarvis/engine
```
Use `npm run`, never `npx tsc` (see /jarvis/CLAUDE.md). Hundreds of "cannot find
module" errors mean the read-only node_modules mounts are not live — not your code.

### 2. Show it on next
- **frontend**: HMR, visible in about a second.
- **backend**: `tsx watch` restarts next-backend on save, a second or two.
- **engine**: NOT watched. Restart next's engine yourself — no host needed:
  ```bash
  curl -s -X POST http://next-engine:3010/restart -H "Authorization: Bearer $INTERNAL_SECRET"
  ```
  It exits and its restart policy brings it back on the new code in ~10 s.
  Only next's chats are affected, never the one you are in.
- **agent/** (skills, rules, CLAUDE.md): next runs its own copy under
  `/jarvis/agent/next/config`, seeded from `agent/` when the stack comes up. To
  preview a skill or prompt change there before prod gets it, sync then restart:
  ```bash
  cp -r /jarvis/agent/skills/. /jarvis/agent/next/config/skills/ && cp -r /jarvis/agent/rules/. /jarvis/agent/next/config/rules/ && cp /jarvis/agent/CLAUDE.md /jarvis/agent/next/config/CLAUDE.md
  curl -s -X POST http://next-engine:3010/restart -H "Authorization: Bearer $INTERNAL_SECRET"
  ```

Put the page in the chat's app pane so the user watches it beside the conversation
(the iframe path is what their browser resolves: `/next/...`, not a container name):
```bash
mkdir -p "$WORKSPACE_DIR/apps/$JARVIS_CONVERSATION_ID"
cat > "$WORKSPACE_DIR/apps/$JARVIS_CONVERSATION_ID/index.html" <<HTML
<!doctype html><html><body style="margin:0"><iframe src="/next/routines" allow="microphone" style="border:0;width:100%;height:100vh"></iframe></body></html>
HTML
curl -s -X POST "$BACKEND_URL/internal/apps" -H 'Content-Type: application/json' -H "X-Internal-Secret: $INTERNAL_SECRET" -d "{\"conversation_id\":\"$JARVIS_CONVERSATION_ID\"}"
curl -s -X POST "$BACKEND_URL/internal/apps/$JARVIS_CONVERSATION_ID/notify" -H "X-Internal-Secret: $INTERNAL_SECRET"
```
Replace `/next/routines` with the route being changed (`/next/` for Today,
`/next/c/<id>` for a fixture conversation, `/next/t/<id>` for a topic,
`/next/settings`…). Register once per conversation; later edits appear on their own.

If next is down (502 / connection refused on next-backend), say so and describe the
change instead. You cannot start it: the host runs the stack with
`COMPOSE_PROFILES=next,browser` in `.env`; the `homelab` skill's
`POST /start/jarvis` (= `docker compose up -d`) brings a stopped profile back.

### 3. Prove it with the e2e suite
```bash
bash /jarvis/e2e/run.sh                          # whole suite, ~25 s
bash /jarvis/e2e/run.sh specs/today.spec.ts      # one spec
```
Every UI change updates the spec that covers it; a new page gets a new spec file.
Fixtures live in `backend/src/fixtures.ts` (fixed ids, re-armed by the suite —
add rows there when a page needs data). The guard fails a test on any console
error or 4xx/5xx; under `/next/` a hardcoded absolute path shows up as one.
**Never `POST /internal/reset` on your own** — it wipes next's whole database,
including what the user was trying there. `POST /internal/fixtures` puts the
fixture rows back without touching anything else.

### 4. QA with the user
They look on next and say yes, or ask for more. Iterate in steps 1–3. A big
change can sit on next for days: it costs prod nothing.

### 5. Ship: commit, then deploy
On the user's yes:
```bash
cd /jarvis && git add <your files> && git commit -m "feat(scope): what changed, and why"
bash "$CLAUDE_CONFIG_DIR/skills/deploy/deploy.sh" [--engine]
```
- Commit **your** files only, one commit per coherent change, message = type(scope)
  + the why. Multi-file changes wait for the review before the commit.
- Pass `--engine` only when `engine/` changed. It ends this conversation's Claude
  process (the next message resumes it) — say so before, and end your turn after.
- `--allow-dirty` is not for your own work. If another chat's file is dirty, name it
  and ask before using it.
- The deploy skill builds the frontend, restarts the backend, kills the engine's
  process when allowed — all from here, no host. What it cannot do it prints as
  `! host:` lines: relay them. Most of those (a compose or Dockerfile change) the
  `homelab` skill can apply: `POST http://homelab-api:3007/start/jarvis` is
  `docker compose up -d` (recreates only what changed); `/rebuild/jarvis` is the
  full `--build --force-recreate` and restarts every Jarvis container, this
  conversation included — ask first.
- Finish by telling the user to reload: the "Jarvis updated its interface" banner
  at the bottom, or ↻ in the sidebar.

### Recovery
A bad deploy is a git problem first: `git diff`, then discard the working tree or
`git revert` the last commit, then deploy again. If the backend is down the
restart endpoint is gone with it — the `homelab` skill's `POST /start/jarvis`
brings the project up on the code now on disk (restarting `jarvis` kills this
conversation; say so).

## Logging in to next yourself
The seed creates `e2e@jarvis.local` with a random password, kept in
`/jarvis/agent/next/data/e2e-credentials.json` (regenerated only on a full wipe).
```bash
TOK=$(curl -s -X POST http://next-backend:3005/api/auth/login -H 'Content-Type: application/json' \
  -d "$(cat /jarvis/agent/next/data/e2e-credentials.json)" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
```
Then in Playwright: open `/next/login` on `http://next-frontend:5173`, set
`localStorage.token`, navigate to `/next/`. That token is refused by prod on
purpose. Never paste it into a tool call; hand it to the browser through a file
or a request.

Next's data is fixtures, not the user's: topics "🧪 Fixtures / ☀️ Daily /
🏗️ Projects" (Projects carries a brief), a markdown showcase, an activity
conversation, a morning-brief run, a fixture app, three crons, two webhooks, two
runs waiting on an answer, an API key. Fixture conversation ids are fixed:
`00000000-0000-4000-8000-00000000000N` (1 markdown, 2 activity, 3 brief, 4 app,
5 question, 6 approval, 7 chat question).

## When to use this skill
**ONLY** when the user explicitly asks to modify Jarvis itself: "let's improve
your interface", "work on Jarvis", "change your chat UI", "add a feature to
Jarvis". Not when they talk about something else that happens to mention UI,
files or code. When in doubt, ask.

## Where things are
```
/jarvis/
├── frontend/src/      React 19, Vite, Tailwind v4 (theme in index.css), React Router v7, lucide icons
│   ├── pages/         TodayPage, ChatPage (routes), RoutinesPage, TopicPage, SettingsPage…
│   ├── components/    ChatView, ChatInput, MessageBubble, Sidebar, RoutinesPill, RoutineForm…
│   ├── stores/        chatStore (zustand)
│   ├── api.ts         API client, types, SSE
│   └── base.ts        BASE_PATH / API_BASE — never hardcode /api or /images
├── backend/src/       Fastify 5, better-sqlite3 (db.ts migrations), routes/, runs.ts, topics.ts, fixtures.ts
├── engine/src/        Claude Code CLI sessions (sessions.ts), HTTP API (index.ts)
├── e2e/               Playwright specs against next (run.sh)
└── agent/             this config dir: CLAUDE.md, rules/, skills/ (read at runtime)
```
