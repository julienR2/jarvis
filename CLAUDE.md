# Jarvis — Personal AI Assistant

A self-hosted, full-stack AI assistant powered by Claude Code CLI, with a chat web interface, voice input, scheduled automation, and file management.

## Git Integration

The Jarvis repo itself is git-controlled. Changes can be reviewed (diff), committed, or reverted through the API. The backend mounts the whole repo at `/jarvis` (working dir), so source, agent config, workspace, and data all live under one tree.

**The agent's container (engine) does not.** It sees its workspace and CLI state
read-write, `frontend/src` read-write (interface proposals), and the engine,
backend, e2e, skills, rules and agent CLAUDE.md read-only. `agent/data` — the DB,
`secrets.json` — is hidden behind a tmpfs, and it gets no `.env`. Its few
credentials come from `agent/data/engine/credentials.json`, a mirror the backend
writes (`backend/src/secrets.ts`). Skills change through `/internal/skills`,
which refuses the built-in ones. See the comment on the engine service in
`docker-compose.yml`, and keep that boundary when adding mounts or env.

**Deploying** happens from the host only, after review and commit:

```bash
docker compose run --rm deploy [--dry-run] [--fast] [--engine] [--all]
```

It typechecks, runs the e2e suite, builds the frontend into `dist/`, and restarts
the backend (and, with `--engine`, the engine). The agent cannot run it. It
refuses untracked or ignored files in `frontend/src` (the agent writes there),
installs the engine's dependencies into its own volume, and runs with a fixed
`PATH` and no `.env` — keep it that way: nothing it executes may come from a
path the agent can write.

**Showing a change**: prod serves the last deployed build, so a page cannot be
previewed by pointing at it. Instead `e2e/` starts a throwaway stack on demand —
the source on disk, its own `mktemp` database seeded with fixtures, a vite dev
server and a stub engine — and `e2e/shot.sh <route>…` screenshots it into the
conversation's uploads folder. About ten seconds, no Docker, and prod's data is
never opened.

**Recovery strategy**: First try discarding uncommitted changes
(`/api/git/discard`). If the repo is clean but still broken, revert the last
commit (`/api/git/revert`). Either way the running code only changes after a
deploy — or, if the backend itself is down, after `docker compose up -d` on the
host.

## Typechecking your own edits

After changing anything under `backend/src` or `frontend/src`:

```bash
npm --prefix /jarvis/backend run typecheck
npm --prefix /jarvis/frontend run typecheck
```

Run it before deploying — the deploy script runs it too and refuses to go on
if it fails, but a type error caught while editing is cheaper than one caught
at deploy time.

**Use `npm run`, never `npx tsc`.** `npm run` resolves the project's own compiler
from its `node_modules/.bin`. npx resolves from the current directory, and in a
project whose `node_modules` is empty it falls through to the registry and installs
a squatter package named `tsc` that just prints "This is not the tsc command you are
looking for", then exits 0. That reads as a missing compiler and is really a silent
no-op.

Each service installs its dependencies into its own named volume
(`backend-node-modules`, `frontend-node-modules`, `engine-node-modules`) rather than
into the host tree, because `better-sqlite3` and `bcrypt` are compiled for this
container's OS and arch. The host tree has none, so from the host, typecheck in a
container that mounts them, e.g. `docker compose run --rm --entrypoint bash deploy -c
'npm --prefix backend run typecheck'`. The engine mounts the backend's and
frontend's read-only, for the agent's frontend typecheck and the e2e stack.
If typecheck reports hundreds of "cannot find module" errors for things like `fs`,
those mounts aren't live — recreate the containers (`docker compose up -d`) rather
than believing the errors.
