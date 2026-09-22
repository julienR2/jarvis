---
name: self-edit
description: Modify Jarvis's own source code (frontend, backend, engine, agent config). Use ONLY when the user explicitly asks to modify Jarvis itself (e.g. "improve your interface", "work on Jarvis", "change your chat UI", "add a feature to Jarvis"). Do NOT activate from ambiguous requests.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Self-Edit Skill — Modify Jarvis

You can edit Jarvis's own source. Three facts shape how:

1. **Nothing you save is live.** Prod runs without file watchers. A change under
   `backend/`, `frontend/` or `engine/` reaches the instance the user is talking
   to only when the `deploy` skill runs, after they approved it. Changes under
   `agent/` (skills, rules, CLAUDE.md) are read at runtime and need no deploy.
2. **You show a change before deploying it, on a throwaway stack.** `e2e/` starts
   one on demand — the source on disk, its own database seeded with fixtures,
   thrown away after. You screenshot it (below) and check it with the suite.
   Prod's data is never in it.
3. **The tree is git, and it is shared.** Other chats may be editing at the same
   time. Commit only your files, and only once the user has said yes. The
   `deploy` skill refuses a dirty tree for that reason.

**You have no Docker.** Everything below runs from inside the engine container:
files under `/jarvis`, git, npm scripts, HTTP to the other containers. Anything
that genuinely needs the host is named as such and handed to the user.

## The loop

### 0. Look before you edit
```bash
cd /jarvis && git status --short && git log --oneline -3
python3 -c "import json;print(json.load(open('/jarvis/agent/data/deployed.json')))"   # what prod runs
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

### 2. Show it
Screenshot the pages you changed, as your edit renders them:
```bash
bash /jarvis/e2e/shot.sh ""            # Today
bash /jarvis/e2e/shot.sh routines settings
bash /jarvis/e2e/shot.sh c/00000000-0000-4000-8000-000000000001 --phone
```
Each route lands as one full-page PNG in this conversation's uploads folder, and
the script prints the paths. Show them with the **literal** path so the chat
renders them inline: `![Routines](/jarvis/agent/workspace/uploads/<id>/routines.png)`.
A route is what follows the origin — `""` for Today, `routines`, `settings`,
`c/<id>` for a fixture chat, `t/<id>` for a topic. `--phone` shoots at 390×844.

It boots a stack per invocation (~10 s), so ask for every route you want in one
call. A `⚠` after a path means that page logged a console error — investigate it
before showing the picture.

### 3. Prove it with the e2e suite
```bash
bash /jarvis/e2e/run.sh                          # whole suite, ~35 s
bash /jarvis/e2e/run.sh specs/today.spec.ts      # one spec
```
Every UI change updates the spec that covers it; a new page gets a new spec file.
Fixtures live in `backend/src/fixtures.ts` (fixed ids) — add rows there when a
page needs data. The guard fails a test on any console error or 4xx/5xx.

The suite and `shot.sh` each start their own stack on their own ports, so they
can run at the same time. Neither can touch prod: different database, different
workspace, and the engine is a stub that holds no sessions.

### 4. QA with the user
They look at the screenshots and say yes, or ask for more. Iterate in steps 1–3.
An unfinished change can sit in the working tree for days: it costs prod nothing.

### 5. Ship: commit, then deploy
On the user's yes:
```bash
cd /jarvis && git add <your files> && git commit -m "feat(scope): what changed, and why"
bash "$CLAUDE_CONFIG_DIR/skills/deploy/deploy.sh" [--engine]
```
- Commit **your** files only, one commit per coherent change, message = type(scope)
  + the why. Multi-file changes wait for the review before the commit.
- Pass `--engine` only when `engine/` changed (its dependencies include the
  `claude` CLI). It ends this conversation's Claude process — the next message
  resumes it — so say so before, and end your turn after.
- `--allow-dirty` is not for your own work. If another chat's file is dirty, name it
  and ask before using it.
- The deploy skill builds the frontend, restarts the backend, and restarts the
  engine when allowed — all from here. What it cannot do it prints as `! host:`
  lines: **relay those verbatim**. They are compose and Dockerfile changes, and
  frontend dependency installs; only the user, on the host, can apply them.
- Finish by telling the user to reload: the "Jarvis updated its interface" banner
  at the bottom, or ↻ in the sidebar.

### Recovery
A bad deploy is a git problem first: `git diff`, then discard the working tree or
`git revert` the last commit, then deploy again. If the backend itself is down,
its restart endpoint is down with it and nothing here can bring it back — tell
the user plainly what broke and that `docker compose up -d` on the host restarts
it on the code now on disk. Say that it ends this conversation.

## The fixture data you are looking at
The throwaway stack is seeded, never the user's data: topics "🧪 Fixtures /
☀️ Daily / 🏗️ Projects" (Projects carries a brief), a markdown showcase, an
activity conversation, a morning-brief run, a fixture app, three crons, two
webhooks, two runs waiting on an answer, an API key. Fixture conversation ids are
fixed: `00000000-0000-4000-8000-00000000000N` (1 markdown, 2 activity, 3 brief,
4 app, 5 question, 6 approval, 7 chat question).

The account is `e2e@jarvis.local` with a password generated per boot — `shot.sh`
and the suite log in for you, and the token dies with the stack. It is refused by
prod on purpose.

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
├── e2e/               the throwaway stack (stack.sh), Playwright specs (run.sh), screenshots (shot.sh)
└── agent/             this config dir: CLAUDE.md, rules/, skills/ (read at runtime)
```
