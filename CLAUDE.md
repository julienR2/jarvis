# Jarvis — Personal AI Assistant

A self-hosted, full-stack AI assistant powered by Claude Code CLI, with a chat web interface, voice input, scheduled automation, and file management.

## Git Integration

The Jarvis repo itself is git-controlled. When Claude modifies backend/frontend code, changes can be reviewed (diff), committed, or reverted through the API. The backend mounts the whole repo at `/jarvis` (working dir), so source, agent config, workspace, and data all live under one tree.

**Deploying**: prod runs without file watchers, so an edit under `backend/`, `frontend/` or `engine/` is inert until the `deploy` skill runs (`agent/skills/deploy/deploy.sh`). It builds the frontend, restarts the backend through `POST /internal/restart`, and restarts the engine only when told to. Edits under `agent/` are read at runtime and need no deploy.

**Recovery strategy**: First try discarding uncommitted changes (`/api/git/discard`). If the repo is clean but still broken, revert the last commit (`/api/git/revert`). Either way the running code only changes after a deploy — or, if the backend itself is down, after the `jarvis` project is restarted on the host.

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
