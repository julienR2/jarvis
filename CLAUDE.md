# Jarvis — Personal AI Assistant

A self-hosted, full-stack AI assistant powered by Claude Code CLI, with a chat web interface, voice input, scheduled automation, and file management.

## Git Integration

The Jarvis repo itself is git-controlled. When Claude modifies backend/frontend code, changes can be reviewed (diff), committed, or reverted through the API. The backend mounts the whole repo at `/jarvis` (working dir), so source, agent config, workspace, and data all live under one tree.

**Showing a change**: prod serves the last deployed build, so a page cannot be
previewed by pointing at it. Instead `e2e/` starts a throwaway stack on demand —
the source on disk, its own `mktemp` database seeded with fixtures, a vite dev
server and a stub engine — and `e2e/shot.sh <route>…` screenshots it into the
conversation's uploads folder. About ten seconds, no Docker, and prod's data is
never opened.

**Deploying**: prod runs without file watchers, so an edit under `backend/`,
`frontend/` or `engine/` is inert until the `deploy` skill runs
(`agent/skills/deploy/deploy.sh`). It typechecks, runs the UI e2e suite against
that same throwaway stack (`e2e/`, ~55 checks on seeded fixtures, ~35 s), builds
the frontend, restarts the backend through `POST /internal/restart`, and restarts
the engine only when told to (`--engine`). None of it needs Docker: it runs from
the engine container. Edits under `agent/` are read at runtime and need no deploy.

**Updating the Claude CLI**: it is a pinned dependency in `engine/package.json`,
not a global install baked into the image, and the engine runs `npm install` on
every start. So bumping the pin and restarting the engine (`deploy.sh --engine`)
is the whole upgrade — no image rebuild.

**Recovery strategy**: First try discarding uncommitted changes
(`/api/git/discard`). If the repo is clean but still broken, revert the last
commit (`/api/git/revert`). Either way the running code only changes after a
deploy — or, if the backend itself is down, after `docker compose up -d` on the
host, which nothing inside the containers can do.

**No Docker inside**: the agent has the compose file and Dockerfiles to read, but
no socket, CLI or API. What it cannot apply itself — compose changes, Dockerfile
changes, new frontend dependencies — `deploy.sh` prints as `! host:` lines for
you to run.

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
container's OS and arch. The engine mounts the backend's and frontend's read-only so
the agent can typecheck code it edits but cannot corrupt what another service runs.
If typecheck reports hundreds of "cannot find module" errors for things like `fs`,
those mounts aren't live — recreate the containers (`docker compose up -d`) rather
than believing the errors.
