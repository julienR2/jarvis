<p align="center">
  <img src="docs/jarvis_wave.gif" alt="Jarvis" width="120">
</p>

<h1 align="center">Jarvis</h1>

<p align="center">A self-hosted AI assistant that can modify its own code.</p>

<p align="center">
  <img src="docs/screenshot-home.png" alt="Jarvis home screen" width="700">
</p>

<p align="center">
  <img src="docs/screenshot-chat.png" alt="Chat conversation with inline image" width="700">
</p>

Jarvis is a web-based chat interface backed by the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code). What makes it different from other AI chat wrappers: the assistant has full read/write access to its own source code. Ask it to add a feature, fix a bug, or build a new integration -- it edits the frontend and backend directly, and you can review, commit, or revert every change through git.

The idea is less "deploy and use" and more "deploy and shape." You start with a general-purpose assistant and vibe-code it into something personal.

## Features

- **Self-coding** -- Claude can edit Jarvis's own frontend and backend through chat. Every change goes through git: diffable, committable, revertable.
- **Apps** -- Claude creates interactive HTML/CSS/JS apps displayed in a split pane alongside chat. Useful for dashboards, tools, visualizations, games.
- **Connectors** -- Plug in Gmail, GitHub, Slack, Linear, and others from the UI. Or create custom connectors with just a name and env var fields -- no code, no restart.
- **Cron jobs** -- Scheduled prompts with full conversation context. "Summarize my inbox every morning at 7am" -- the agent writes the cron itself.
- **Webhooks** -- HTTP endpoints that trigger the agent with arbitrary payloads. Works well with n8n, Home Assistant, iOS Shortcuts, etc.
- **Voice input** -- Audio transcribed via Whisper and injected into the conversation.
- **Skills** -- Modular instruction sets (Markdown files) that auto-activate based on context. The agent can create new skills for itself.
- **Plugins** -- Add Claude Code plugin marketplaces from Settings, install plugins, toggle them on or off. Enabled plugins load in every conversation, cron and webhook.
- **Browser** -- A real Chromium the agent drives through Playwright, for sites that need clicking rather than fetching.
- **Sharing** -- Send someone a link to a conversation, read-only or with replies. No account needed on their side.
- **Mobile PWA** -- Installable, responsive, with push notifications and share target support.

### Apps

Ask Jarvis to build you a tool, game, or visualization -- it writes the HTML/CSS/JS and renders it in a split pane next to the chat.

<p align="center">
  <img src="docs/screenshot-app.png" alt="App split view — neural network explainer" width="700">
</p>

### Connectors

Plug in third-party services from the UI. Built-in connectors for Gmail, GitHub, Slack, Linear, and ElevenLabs. Create custom connectors with just a name and env var fields -- no code, no restart.

<p align="center">
  <img src="docs/screenshot-connectors.png" alt="Connectors settings page" width="700">
</p>

### Cron jobs & Webhooks

Schedule prompts on any cron expression. Expose HTTP endpoints that trigger the agent with arbitrary payloads -- works well with n8n, Home Assistant, iOS Shortcuts.

<p align="center">
  <img src="docs/screenshot-crons.png" alt="Cron jobs page" width="340">
  <img src="docs/screenshot-webhooks.png" alt="Webhooks page" width="340">
</p>

### Git integration

Browse the codebase, review diffs, and commit -- all from the web UI. Every change Claude makes is a file change you can diff, commit, or throw away.

<p align="center">
  <img src="docs/screenshot-git.png" alt="Changed files view" width="700">
</p>

### Browser

Some things can't be fetched, they have to be clicked -- a site behind a login, a flow with no API. Jarvis ships a headless Chromium the agent drives over the Playwright MCP server, and it is available to every conversation with no setup.

Headless has a limit: it can't solve a captcha or take a login you'd rather type yourself. For that there is an optional headful browser you can watch and take over, handing control back when you're done.

### Sharing

Share a conversation with a link. Read-only shows the transcript as it continues; "can reply" lets the other person answer too. They get a stripped view -- the conversation, and the app if there is one -- with no access to the rest of your instance, and no account needed. Links can be revoked or regenerated at any time.

Generated apps have their own links, separate from conversation shares and separately revocable.

## Guardrails

Giving an AI write access to its own code sounds reckless. Here is what makes it workable:

- **Git is the undo button.** Every modification is a file change you can diff, commit, or throw away. Settings → Code → Changed has commit, discard-all, and revert-last-commit, so recovery never depends on the chat that broke things still working.
- **The agent can't reach your login.** The Claude subprocess runs with the JWT signing key and admin credentials stripped from its environment.
- **Credentials live outside the code.** Connector secrets are in the database and read at runtime, so nothing the agent commits can leak them into git history.
- **Nothing is exposed by accident.** Published ports bind to localhost; everything else talks over the Docker network. What reaches the internet is whatever you deliberately put a reverse proxy in front of.

The recovery strategy: discard uncommitted changes first. If the tree is clean but still broken, revert the last commit. If the UI won't load at all, both are one `git` command away on the host -- the repo is a normal checkout.

## Security

Worth being plain about, because Jarvis is unusual: it is an agent with a shell, write access to its own source, and your credentials.

- **Single-user by design.** Every account on an instance is a full admin -- all conversations, all connector secrets, git write access. There is no permission model. Don't hand out accounts; hand out share links.
- **The agent runs unattended.** It executes commands without prompting for approval, because a cron firing at 7am has nobody to ask. Whatever the agent can reach, a sufficiently convincing web page or email it reads can also reach. Give it credentials scoped to what it actually needs.
- **First run is claimed with a code.** Creating the first account requires a setup code printed in the backend logs, so an instance that is reachable before you have configured it can't be taken over by whoever finds it.
- **Secrets are generated, never defaulted.** JWT and internal secrets are random on first boot and stored outside git. There are no default credentials, and placeholder values are actively rejected.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Quick Start

Requires Docker and Docker Compose (v2.24+).

```bash
git clone <repo-url> jarvis
cd jarvis
docker compose up -d
```

Open `http://localhost:5173`. The first visit walks you through the rest: create your account, then paste a Claude OAuth token (the wizard shows how to get one with `claude setup-token` -- requires a Claude subscription). Secrets are auto-generated on first boot; there is nothing to configure by hand.

Creating that first account asks for a **setup code**, which is printed in the backend logs:

```bash
docker compose logs backend | grep setup
```

It's there so that an instance reachable from the internet before you've finished setting it up can't be claimed by someone else. Set `SETUP_CODE` in `.env` to pin your own instead.

Your Claude credentials aren't frozen at setup: Settings → Connection changes them at any time, and can point Jarvis at OpenRouter or any Anthropic-compatible gateway instead. Both are verified before they're saved, and take effect on your next message without a restart.

No `.env` file is needed. To pre-seed values instead -- a headless install, or handing off a pre-configured instance -- copy `.env.example` to `.env` and fill in what you want (OAuth token, admin credentials, timezone).

## Architecture

```
jarvis/
├── backend/          Fastify API + SSE streaming + cron scheduler
├── frontend/         React SPA (chat, settings, connectors, app preview)
├── engine/           Owns the Claude CLI subprocess lifecycle
├── agent/            Claude config: system prompt, skills, rules
├── workspace/        Claude's scratch space: memory, uploads, apps
└── docker-compose.yml
```

| Service | Port | Description |
|---------|------|-------------|
| frontend | 5173 | Web UI |
| backend | 3005 | REST API + SSE streaming |
| engine | -- | Internal: owns Claude CLI process |
| whisper | -- | Internal: speech-to-text |
| playwright | -- | Internal: Chromium the agent drives via MCP |

- **Backend**: Fastify 5, better-sqlite3 (WAL mode), TypeScript
- **Frontend**: React 19, Vite, Tailwind CSS 4, TypeScript
- **AI engine**: Claude Code CLI spawned as a subprocess per conversation, streaming JSON events to the browser over SSE
- **Infrastructure**: Docker Compose, Node 25

## Make It Yours

The point of Jarvis is that it adapts to you. A few ways in:

**Add connectors from the UI.** Go to Settings, then Connectors. Built-in options include Gmail, GitHub, Slack, Linear, and others. Credentials are stored in SQLite and injected into the Claude process at runtime -- no `.env` changes, no restarts.

**Create custom connectors.** Give it a name and a set of environment variable fields. That is it -- no code required. The values are available to Claude immediately.

**Install plugins.** Go to Settings, then Plugins. Add a marketplace by `owner/repo`, a git URL, or a local path (`anthropics/claude-code` is the official one), then install what you want from its catalogue. Plugins go in at user scope, so an enabled one is available to every conversation, cron and webhook -- warm chats pick it up on their next message. Plugins that gate themselves behind an opt-in flag file get a third state, **Always on**, which sets that flag so the plugin injects itself into every session instead of waiting to be called. Under the hood this drives `claude plugin` in the engine container, so `agent/settings.json` stays exactly as the CLI expects it.

**Write skills.** Skills are Markdown files in `agent/skills/<name>/SKILL.md`. Each one describes a capability -- when to use it, what tools to call, what APIs to hit. Claude reads the relevant skill automatically based on conversation context. You can also ask Claude to write skills for itself: "create a skill that queries my Notion database."

**Self-edit through chat.** This is the big one. Ask Jarvis to change its own interface, add a new API endpoint, or build a feature you want. It modifies the source directly and the container rebuilds; a banner appears when the new build is ready, and reloading picks it up. If something breaks, Settings → Code → Changed has discard and revert.

## Stack

TypeScript throughout. Node 25, Fastify 5, React 19, better-sqlite3, Vite, Tailwind CSS 4, Docker Compose. The AI engine is the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) running as a subprocess.

## License

MIT
