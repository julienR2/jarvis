---
name: deploy
description: Put edited Jarvis source into the running instance. Use after modifying anything under backend/, frontend/ or engine/ once the user has approved the change — prod runs WITHOUT file watchers, so nothing you save is live until this runs. Triggers on "deploy", "déploie", "mets en prod", "ship it", "apply it", "make it live", or when the user says a Jarvis change looks good.
allowed-tools: Bash
---

# Deploy — make the code on disk the code that runs

Prod Jarvis has no file watchers: the backend runs `tsx` without `watch`, the
frontend serves a fixed `dist/`, the engine loads once. A saved edit changes
nothing until deployed. That is deliberate — a half-saved file used to take the
instance down mid-conversation. (The `next` stack, when up, is where edits show
live: point the app pane at `/next/<page>`.)

## Run it

```bash
bash "$CLAUDE_CONFIG_DIR/skills/deploy/deploy.sh" [--fast] [--dry-run] [--allow-dirty] [--engine] [--all]
```

| flag | meaning |
|---|---|
| `--dry-run` | print the plan (which services, host actions) and stop |
| `--allow-dirty` | deploy uncommitted work; still records HEAD in the marker |
| `--fast` | skip the e2e run against next (about 10 s when next is up) |
| `--engine` | allowed to restart the engine (see below) |
| `--all` | ignore the marker; treat every service as changed |

It works out what changed since the last deploy (`agent/data/deployed.json`),
typechecks what it will touch, runs the **e2e suite against next** (`e2e/run.sh`:
re-arms the fixtures on next (only their rows; the rest of next's data stays), then
UI-only checks — access, chat rendering, sidebar, Today, Routines, topics, needs-you,
settings, a console/failed-request guard; ~45 specs in ~25 s), and only then
applies, in this order:

1. **frontend** — builds from the engine container, copies hashed assets in,
   swaps `index.html` last. Zero downtime. Open tabs get the "Jarvis updated
   its interface" banner; tell the user to use it.
2. **backend** — `POST /internal/restart`, waits for `/health`. ~2–3 s blip;
   SSE clients reconnect on their own. Runs mid-conversation keep going.
3. **engine** — only with `--engine`. Ends the engine's node process after 10 s,
   detached, so your reply lands first; the container's restart policy brings it
   back on the new code. **This ends the current conversation's Claude process**;
   the next user message resumes the session with full context. Always say so
   before passing the flag, and prefer ending your turn right after.

All of that runs from the engine container — no Docker needed. What it cannot
apply is printed as `! host:` lines: Dockerfiles, compose files, frontend
dependency changes. Most of those the `homelab` skill can still do from here:
`POST http://homelab-api:3007/start/jarvis` is `docker compose up -d` (recreates
only the containers whose definition changed), `POST /rebuild/jarvis` is the full
`--build --force-recreate` and restarts every Jarvis container, this conversation
included — ask before. Otherwise relay the line verbatim for the host.

`! note:` lines are about dependencies: backend and engine install theirs on
restart, so a new package fails the typecheck until the service has restarted
once. The line says which restart to do first.

Changes under `agent/` (skills, rules, CLAUDE.md, memory) need no deploy — prod
reads them at runtime. Next runs its own copy (`agent/next/config`), refreshed
when the stack comes up; the `jarvis` skill says how to sync it by hand.

Next's engine is not part of a deploy: it is restarted with
`POST http://next-engine:3010/restart` (Bearer `$INTERNAL_SECRET`) whenever an
engine change should show on next.

## How to use it in a conversation

- Default is a clean tree. Commit first (the user reviews multi-file changes
  before a commit — ask, then commit, then deploy). `--allow-dirty` is for
  quick visual fixes the user has already seen and okayed.
- Start with `--dry-run` when unsure what will be touched.
- Report the script's summary lines, not its internals. If the frontend was
  deployed, end with the reload instruction.
- If the backend does not come back within 30 s the script exits non-zero.
  Recovery: `git diff` / `git revert` the offending change, then run deploy
  again — the restart endpoint is on the *new* code, so if the backend is truly
  down, `POST http://homelab-api:3007/start/jarvis` (homelab skill) brings the
  project up on the code now on disk. Say that it restarts this conversation.

## The e2e suite

`e2e/` is its own small package (Playwright test runner, system Chromium of the
engine container). Run it alone with `bash /jarvis/e2e/run.sh`; a single spec with
`bash /jarvis/e2e/run.sh specs/chat.spec.ts`. Exit 3 means next is not up, and the
deploy then continues with a `! e2e not run` line rather than failing.

A failure prints the failing assertions; artefacts (screenshot, trace,
`error-context.md` with the page's accessibility snapshot) land in `e2e/results/`.
The guard fails a test on any `console.error`, uncaught exception, or 4xx/5xx
response the page provoked — under the `/next/` mount that is exactly how a
hardcoded absolute path shows up.

When you change the UI, extend the spec that covers it rather than loosening an
assertion. Fixture data lives in `backend/src/fixtures.ts`.
