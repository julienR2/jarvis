---
name: deploy
description: Put edited Jarvis source into the running instance. Use after modifying anything under backend/, frontend/ or engine/ once the user has approved the change — prod runs WITHOUT file watchers, so nothing you save is live until this runs. Triggers on "deploy", "déploie", "mets en prod", "ship it", "apply it", "make it live", or when the user says a Jarvis change looks good.
allowed-tools: Bash
---

# Deploy — make the code on disk the code that runs

Prod Jarvis has no file watchers: the backend runs `tsx` without `watch`, the
frontend serves a fixed `dist/`, the engine loads once. A saved edit changes
nothing until deployed. That is deliberate — a half-saved file used to take the
instance down mid-conversation. (To *show* a change before deploying it, use the
`jarvis` skill's `e2e/shot.sh`: it screenshots your edit on a throwaway stack.)

## Run it

```bash
bash "$CLAUDE_CONFIG_DIR/skills/deploy/deploy.sh" [--fast] [--dry-run] [--allow-dirty] [--engine] [--all]
```

| flag | meaning |
|---|---|
| `--dry-run` | print the plan (which services, host actions) and stop |
| `--allow-dirty` | deploy uncommitted work; still records HEAD in the marker |
| `--fast` | skip the e2e run (saves about 35 s) |
| `--engine` | allowed to restart the engine (see below) |
| `--all` | ignore the marker; treat every service as changed |

It works out what changed since the last deploy (`agent/data/deployed.json`),
typechecks what it will touch, runs the **e2e suite** (`e2e/run.sh`: starts a
throwaway stack — the source on disk, its own seeded database, a stub engine —
then UI-only checks: access, chat rendering, sidebar, Today, Routines, topics,
needs-you, settings, a console/failed-request guard; ~55 specs in ~35 s), and
only then applies, in this order:

1. **frontend** — builds from the engine container, copies hashed assets in,
   swaps `index.html` last. Zero downtime. Open tabs get the "Jarvis updated
   its interface" banner; tell the user to use it.
2. **backend** — `POST /internal/restart`, waits for `/health`. ~2–3 s blip;
   SSE clients reconnect on their own. Runs mid-conversation keep going.
3. **engine** — only with `--engine`. Ends the engine's node process after 10 s,
   detached, so your reply lands first; the container's restart policy brings it
   back on the new code, reinstalling its dependencies as it does — which is how
   a `claude` CLI bump in `engine/package.json` lands. **This ends the current
   conversation's Claude process**; the next user message resumes the session
   with full context. Always say so before passing the flag, and prefer ending
   your turn right after.

All of that runs from the engine container. **There is no Docker in here**, so
what a container cannot change about itself is printed as `! host:` lines —
Dockerfiles, compose files, frontend dependency installs. Relay those verbatim
for the user to run on the host; do not look for a way around them.

`! note:` lines are about dependencies: backend and engine install theirs on
restart, so a new package fails the typecheck until the service has restarted
once. The line says which restart to do first.

Changes under `agent/` (skills, rules, CLAUDE.md, memory) need no deploy — prod
reads them at runtime.

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
  down, nothing here can reach it. Tell the user what broke and that
  `docker compose up -d` on the host brings the project up on the code now on
  disk. Say that it ends this conversation.

## The e2e suite

`e2e/` is its own small package (Playwright test runner, system Chromium of the
engine container). `stack.sh` is the throwaway stack it runs against: a backend
on a `mktemp` database seeded with fixtures, a vite dev server, and a stub
engine, all started and stopped per run. Prod's database, workspace and engine
are never touched.

Run it alone with `bash /jarvis/e2e/run.sh`; a single spec with
`bash /jarvis/e2e/run.sh specs/chat.spec.ts`. Exit 3 means the stack could not
start (usually an earlier run still holding its ports — the message says how to
clear it), and the deploy then continues with a `! e2e not run` line rather than
failing.

A failure prints the failing assertions; artefacts (screenshot, trace,
`error-context.md` with the page's accessibility snapshot) land in `e2e/results/`.
The guard fails a test on any `console.error`, uncaught exception, or 4xx/5xx
response the page provoked.

When you change the UI, extend the spec that covers it rather than loosening an
assertion. Fixture data lives in `backend/src/fixtures.ts`.
