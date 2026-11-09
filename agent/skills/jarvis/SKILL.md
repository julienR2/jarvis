---
name: self-edit
description: Propose changes to Jarvis's own interface (frontend/src — layout, styling, components, copy). Use ONLY when the user explicitly asks to change Jarvis itself (e.g. "improve your interface", "change your chat UI", "make the sidebar narrower"). Do NOT activate from ambiguous requests. Backend, engine and agent config are not editable from here.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Self-Edit Skill — propose interface changes

You can change Jarvis's **interface**, and only that. Four facts shape how:

1. **Only `/jarvis/frontend/src/` is writable.** The rest of the frontend
   (package.json, vite config, the built `dist/`), the backend, the engine and
   your own config (CLAUDE.md, rules, settings) are mounted read-only. That is
   deliberate: the logic and the security of Jarvis are not in reach of
   anything a web page or an email could talk you into. Skills are the one
   exception, through their API — see the `skills` skill.
2. **Nothing you save is live.** Prod serves the last deployed build. Your edit
   reaches it only after the user has reviewed it, committed it and deployed it
   **from the host** (`docker compose run --rm deploy`). You cannot deploy, and
   you cannot commit: there is no git here.
3. **You show a change on a throwaway stack.** `e2e/` starts one on demand —
   the source on disk, its own database seeded with fixtures, thrown away
   after. You screenshot it (below) and check it with the suite. Prod's data is
   never in it.
4. **The tree is shared.** Other chats may be editing `frontend/src` too. Touch
   only what your change needs, and list the files you changed when you hand it
   over.

If the user asks for something that needs the backend or engine (a new API
route, a new column, a change to how sessions run), say so plainly: describe the
change and leave it for them to make in their development environment.

## The loop

### 1. Edit
Explore with `Glob`/`Grep`, read before editing, follow existing patterns. One
change at a time. Typecheck:
```bash
npm --prefix /jarvis/frontend run typecheck
```
Use `npm run`, never `npx tsc`. Hundreds of "cannot find module" errors mean the
read-only node_modules mount is not live — not your code.

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

### 3. Check it with the e2e suite
```bash
bash /jarvis/e2e/run.sh                          # whole suite, ~35 s
bash /jarvis/e2e/run.sh specs/today.spec.ts      # one spec
```
The specs are read-only here. If your change breaks an assertion that should
change with it, say which one and why in the hand-over; the user updates it.

The suite and `shot.sh` each start their own stack on their own ports, so they
can run at the same time. Neither can touch prod: different database, different
workspace, and the engine is a stub that holds no sessions.

### 4. Hand it over
When the user is happy with the screenshots, tell them:
- the files you changed under `frontend/src/` — say which are **new**: the
  deploy refuses any file there git does not track, so the user has to review
  and commit those before anything ships;
- that it is uncommitted in the working tree, ready to review (the Code page
  shows the diff), commit, and deploy from the host with
  `docker compose run --rm deploy`.

An unfinished change can sit in the working tree for days: it costs prod
nothing. To drop it, the user discards it from the Code page.

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
**ONLY** when the user explicitly asks to change Jarvis's interface: "let's
improve your interface", "change your chat UI", "make this page clearer". Not
when they talk about something else that happens to mention UI, files or code.
When in doubt, ask.

## Where things are
```
/jarvis/
├── frontend/src/      writable — React 19, Vite, Tailwind v4 (theme in index.css), React Router v7, lucide icons
│   ├── pages/         TodayPage, ChatPage (routes), RoutinesPage, TopicPage, SettingsPage…
│   ├── components/    ChatView, ChatInput, MessageBubble, Sidebar, RoutinesPill, RoutineForm…
│   ├── stores/        chatStore (zustand)
│   ├── api.ts         API client, types, SSE
│   └── base.ts        BASE_PATH / API_BASE — never hardcode /api or /images
├── backend/src/       read-only — for reading API shapes; fixtures.ts seeds the throwaway stack
├── engine/            read-only — the code running you
├── e2e/               read-only — the throwaway stack (stack.sh), specs (run.sh), screenshots (shot.sh)
└── agent/             your config dir: CLAUDE.md, rules/, skills/ read-only; workspace/ writable
```
