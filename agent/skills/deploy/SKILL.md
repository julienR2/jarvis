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
| `--fast` | skip e2e (not wired yet — phase 3) |
| `--engine` | allowed to restart the engine (see below) |
| `--all` | ignore the marker; treat every service as changed |

It works out what changed since the last deploy (`agent/data/deployed.json`),
typechecks what it will touch, then applies in this order:

1. **frontend** — builds from the engine container, copies hashed assets in,
   swaps `index.html` last. Zero downtime. Open tabs get the "Jarvis updated
   its interface" banner; tell the user to use it.
2. **backend** — `POST /internal/restart`, waits for `/health`. ~2–3 s blip;
   SSE clients reconnect on their own. Runs mid-conversation keep going.
3. **engine** — only with `--engine`. Kills PID 1 after 10 s, detached, so your
   reply lands first. **This ends the current conversation's Claude process**;
   the next user message resumes the session with full context. Always say so
   before passing the flag, and prefer ending your turn right after.

Changes it cannot apply from a container are printed as `! host:` lines —
Dockerfiles, compose files, frontend dependency changes. Relay them verbatim;
the user runs `docker compose up -d --build` (or the homelab rebuild) on the host.

Changes under `agent/` (skills, rules, CLAUDE.md, memory) need no deploy — they
are read at runtime.

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
  down the user restarts the `jarvis` project via the homelab skill.
