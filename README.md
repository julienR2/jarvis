# Jarvis

A self-hosted, full-stack personal AI assistant. Chat with Claude through a web UI, have it run on a schedule, trigger it from webhooks, and teach it new skills by adding a Markdown file.

- **Chat UI** with streaming responses, voice input (Whisper), dark mode, and PWA support
- **Scheduled automation** — ask Jarvis to "summarise my inbox every morning at 7am" and it writes the cron itself
- **Webhooks** — HTTP endpoints that fire the agent with any payload (great for n8n, Home Assistant, Shortcuts, etc.)
- **Mini-apps** — the agent can spin up an HTML/CSS/JS widget alongside the chat for anything it wants to visualise
- **Connectors** — add API keys for Gmail, GitHub, Linear, etc. from the UI. No restart, no `.env` fiddling
- **Self-editing** — Jarvis can modify its own source code. A separate admin recovery page (port 3006) can undo any damage

## Stack

TypeScript, Fastify 5, React 19, better-sqlite3, Vite, Tailwind 4, Docker Compose. The AI engine is the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) running as a subprocess.

## Quick start

Requires Docker and Docker Compose.

```bash
git clone <this-repo> jarvis
cd jarvis
cp .env.example .env
# Open .env and set JWT_SECRET and CLAUDE_CODE_OAUTH_TOKEN (see below)
docker compose up -d
open http://localhost:5173
```

First visit will prompt you to create an admin account. From there, everything else — adding skill credentials, setting up crons, creating webhooks — happens inside the chat or in the Connectors page.

### Getting a Claude OAuth token

Install the Claude CLI on any machine and run:

```bash
claude login
cat ~/.claude/.credentials.json   # copy the accessToken value
```

Paste it into `.env` as `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...`.

### Generating a JWT secret

```bash
openssl rand -hex 32
```

### Optional: personal docker-compose overrides

If you want to attach Jarvis to an existing Docker network or override ports, copy `docker-compose.override.example.yml` to `docker-compose.override.yml` and edit. Docker Compose will auto-merge it.

## Architecture

```
jarvis/
├── backend/          Fastify API + SSE streaming + cron scheduler
├── frontend/         React SPA (chat UI, settings, connectors, mini-app preview)
├── session-manager/  Owns the Claude CLI subprocess lifecycle
├── admin/            Emergency recovery page (zero-deps Node)
├── agent/            Claude's config: CLAUDE.md, skills, rules, settings.json
├── data/             SQLite DB + runtime state (gitignored)
├── workspace/        Claude's scratch space: memory, uploads, mini-apps (gitignored)
└── docker-compose.yml
```

| Service          | Port   | Role                                   |
|------------------|--------|----------------------------------------|
| frontend         | 5173   | Web UI                                 |
| backend          | 3005   | REST + SSE                             |
| admin            | 3006   | Recovery page (bound to localhost)     |
| session-manager  | —      | Internal — owns Claude CLI process     |
| whisper          | —      | Internal — speech-to-text              |

## Recovery

If Jarvis ever breaks itself (it can edit its own code, so this can happen), open `http://localhost:3006` to discard uncommitted changes, revert the last commit, or restart the backend.

## Configuration

Only two `.env` variables are required:

- `JWT_SECRET` — signs login tokens
- `CLAUDE_CODE_OAUTH_TOKEN` — the Anthropic OAuth token from `claude login`

Everything else is optional — see `.env.example` for the full list. Skill credentials (Gmail, GitHub, etc.) are not set in `.env`; they are added through the UI and stored encrypted at rest in SQLite.

## Teaching Jarvis new skills

Skills are Markdown files in `agent/skills/<name>/SKILL.md`. Each file is an instruction to the Claude agent describing when to invoke the skill and how to use it (usually via `curl` or `bash`). No code to write — just explain the capability to the agent.

The agent can also write skills itself. Tell it "create a skill that lets you query my Notion database," give it the API details, and it will generate the `SKILL.md` for you.

## License

MIT — see [LICENSE](LICENSE).
