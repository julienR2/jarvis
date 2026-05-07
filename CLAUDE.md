# Jarvis — Personal AI Assistant

A self-hosted, full-stack AI assistant powered by Claude Code CLI, with a chat web interface, voice input, scheduled automation, and file management.

## Architecture

```
jarvis/
├── backend/       # Fastify 5 API + WebSocket server (TypeScript, Node 25)
├── frontend/      # React 19 SPA with Vite + Tailwind CSS 4 (TypeScript)
├── admin/         # Emergency recovery page (plain Node.js, zero deps)
├── data/          # Runtime data (SQLite DB, Claude config, workspace)
└── docker-compose.yml
```

All services run in Docker containers (backend, frontend, admin, whisper). The admin service is an independent recovery page that can revert git changes and restart Jarvis if a bad change breaks the main UI.

## Tech Stack

- **Backend**: Fastify 5, better-sqlite3 (WAL mode), node-cron, JWT auth, bcrypt
- **Frontend**: React 18, React Router v6, Tailwind CSS 3, react-markdown, Lucide icons
- **Infrastructure**: Docker Compose, Node 25 Alpine
- **External**: Whisper ASR (speech-to-text), Claude Code CLI (AI engine)

## Key Features

- **Chat**: Real-time WebSocket messaging with Claude Code CLI, streaming responses, conversation history, auto-generated titles
- **Cron jobs**: Scheduled Claude prompts with cron expressions, conversation linking, timezone-aware (configurable via `TZ`)
- **Webhooks**: HTTP-triggered Claude prompts with token-based auth, payload support, conversation linking — for external integrations (n8n, etc.)
- **Voice input**: Audio recording transcribed via Whisper, injected into chat
- **File browser**: Read/write files in `/workspace` and `/claude` directories with path traversal protection
- **PWA**: Installable with share target support, service worker, responsive mobile layout
- **Mini-apps**: Claude can create interactive HTML/CSS/JS apps displayed in an iframe alongside chat. Desktop: split layout (3/5 chat, 2/5 preview). Mobile: toggle between chat and preview.
- **Themes**: Dark/light toggle persisted in localStorage

## Running

```bash
docker-compose up
# Backend:  localhost:3005
# Frontend: localhost:5173
# Admin:    localhost:3006  (recovery page)
```

Source directories are mounted as volumes for hot reload in development.

## Backend API

### REST (JWT-protected)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/login` | Authenticate |
| GET | `/api/auth/me` | Current user |
| GET/POST | `/api/conversations` | List / create conversations |
| GET/PATCH/DELETE | `/api/conversations/:id` | Read / update / delete |
| GET/POST/PATCH/DELETE | `/api/crons[/:id]` | Cron CRUD |
| GET/POST/PATCH/DELETE | `/api/webhooks[/:id]` | Webhook CRUD |
| POST | `/api/hooks/:token/trigger` | Public webhook trigger (no JWT) |
| GET | `/api/files` | List files |
| GET/PUT | `/api/files/content` | Read / write file content |
| GET | `/api/git/status` | Git status (branch, dirty, changed files) |
| GET | `/api/git/diff` | Uncommitted diff (staged + unstaged) |
| GET | `/api/git/log` | Recent commits |
| GET | `/api/git/log/:hash` | Show a specific commit diff |
| POST | `/api/git/commit` | Commit all changes `{message}` |
| POST | `/api/git/discard` | Discard uncommitted changes |
| POST | `/api/git/revert` | Reset last commit (hard) |

### WebSocket (JWT via query param)

| Path | Purpose |
|------|---------|
| `/ws/chat/:conversationId` | Streaming chat (events: thinking, tool, chunk, done) |
| `/ws/audio` | Audio transcription |

### Internal API (X-Internal-Secret header)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/internal/crons` | Upsert cron by name |
| DELETE | `/internal/crons/:name` | Delete cron |
| GET | `/internal/crons` | List crons |
| POST | `/internal/webhooks` | Upsert webhook by name |
| DELETE | `/internal/webhooks/:name` | Delete webhook |
| GET | `/internal/webhooks` | List webhooks |
| POST | `/internal/mini-apps` | Register conversation as mini-app |
| POST | `/internal/mini-apps/:id/notify` | Trigger frontend preview refresh |

## Admin Recovery Service (port 3006)

A dead-simple, standalone Node.js server with zero dependencies. Serves a static HTML page for emergency recovery when Jarvis breaks itself. Cannot be broken by Jarvis changes because it runs in its own container with its own code.

- Shows git status (clean/dirty) and recent commits
- **Discard changes**: `git checkout -- . && git clean -fd` (for uncommitted breaking changes)
- **Revert last commit**: `git reset --hard HEAD~1` (for committed breaking changes)
- **Restart Jarvis**: Restarts backend + frontend containers via Docker socket API

## Git Integration

The Jarvis repo itself is git-controlled. When Claude modifies backend/frontend code, changes can be reviewed (diff), committed, or reverted through the API. The backend mounts the whole repo at `/jarvis` (working dir), so source, agent config, workspace, and data all live under one tree. The admin service mounts it separately at `/jarvis` too (different container, git recovery only).

**Recovery strategy**: First try discarding uncommitted changes. If the repo is clean but still broken, revert the last commit.

## Database (SQLite)

Tables: `users`, `conversations` (includes `mini_app_path`), `messages`, `crons`, `webhooks`. Foreign keys enabled with cascade deletes.

## Environment Variables

`JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CLAUDE_CODE_OAUTH_TOKEN`, `INTERNAL_SECRET`, `DB_PATH`, `WORKSPACE_DIR`, `CLAUDE_CONFIG_DIR`, `WHISPER_URL`, `PORT`, `TZ`

## Claude CLI Integration

The backend spawns `claude` as a subprocess per conversation, streaming JSON events back over WebSocket. Allowed tools: Bash, Read, Write, Edit, WebSearch, WebFetch. Session IDs maintain context continuity across messages. Active processes are tracked per conversation to prevent concurrent requests.

## Runtime Claude Config

`data/claude/CLAUDE.md` contains the system prompt and instructions for the Claude CLI agent (memory paths, skills, cron API usage, formatting rules). This is separate from this file — that one configures the AI agent behavior, this one documents the project.
