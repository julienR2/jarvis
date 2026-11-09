# Security

## Reporting a vulnerability

Please report security issues privately rather than in a public issue: open a
[GitHub security advisory](https://github.com/julienR2/jarvis/security/advisories/new)
on this repository.

Include what you found, how to reproduce it, and what an attacker gets. I'll
acknowledge within a few days. This is a personal project, not a funded one —
there's no bounty, but credit in the fix if you'd like it.

## What Jarvis is

Understanding the threat model matters more here than in most self-hosted apps,
because Jarvis is an AI agent with a shell and whatever credentials you give it.

**The agent runs without asking permission.** Tool calls aren't gated behind
approval prompts — a cron firing at 7am has nobody to ask. In practice this
means the agent can run commands and use every connector you have configured,
on its own initiative.

**So the boundary is the container, not the prompt.** Anything the agent's
process can read, a prompt-injected turn can read. Jarvis therefore keeps what
matters out of the engine container (where the agent runs) rather than asking
the agent not to look — see *What is protected*.

**Prompt injection is the main risk.** The agent reads web pages, emails, and
webhook payloads. Any of those can contain instructions. Treat everything the
agent can reach as reachable by whoever wrote the content it reads, and scope
credentials accordingly: an API key limited to one repository is a much smaller
problem than one that can delete an account.

**Every account is a full admin.** There is no permission model. Anyone who can
log in can read every conversation, read connector secrets in cleartext, edit
the source, and install plugins. Jarvis is built for one person per instance.
To let someone see a conversation, share a link — don't create them an account.

## What is protected

- **No default credentials.** JWT and internal secrets are generated randomly on
  first boot into `agent/data/secrets.json` (mode 0600). Placeholder values are
  actively rejected.
- **First-run claim requires server access.** Creating the first account needs a
  setup code printed to the backend logs, so an instance exposed before it is
  configured can't be claimed by a stranger.
- **The agent can't read the database or the secrets file.** `agent/data` (the
  SQLite database, `secrets.json` with the JWT signing key, VAPID keys) is
  hidden from the engine container, and the engine gets no `.env`. It reads its
  credentials from a mirror the backend writes, holding only what the agent's
  environment carries anyway (see below). Data reaches the agent through the
  backend's `/internal` API.
- **The agent can't change its own logic, or deploy.** The engine and backend
  source, the agent's CLAUDE.md, rules and settings are mounted read-only.
  Skills change through an API that refuses the built-in ones. The agent may
  edit `frontend/src`, which is inert until a person reviews, commits and
  deploys it from the host (`docker compose run --rm deploy`). The deploy
  refuses any file in `frontend/src` that git does not track, so nothing
  reaches the bundle without showing up in the review, and it never runs
  anything from a place the agent can write (its own `node_modules`, a fixed
  `PATH`, no `.env`).
- **Files the agent writes are served without following its symlinks.** The
  engine and backend mount the same tree, but only the backend sees
  `agent/data`; a link planted in the workspace would otherwise resolve there.
  App files, uploads and the Code page resolve links and refuse any that leave
  their folder.
- **Connector values can be hidden from the agent.** A connector set to *Hide
  secret values from Jarvis* never hands its secrets to the agent: it calls the
  service through the backend's proxy, which attaches them, follows redirects
  only within the service's own origin, and never forwards the caller's own
  credentials upstream. For HTTP APIs.
- **Passwords** are bcrypt hashed. **SQL** is parameterised throughout.
  **Subprocesses** are spawned with argument arrays, never a shell string.
- **Share links are scoped capabilities.** A conversation share opens one
  conversation; an app link opens one app. Neither carries account rights, and
  both can be revoked by regenerating them.
- **Ports bind to localhost.** Inter-service traffic stays on the Docker
  network. What reaches the internet is whatever you put a proxy in front of.

## Known limitations

Being honest about the things that are not solved:

- **Connector secrets are stored in cleartext** in SQLite. Anyone with the
  database file, or a login, can read them. Connectors left on *Jarvis reads
  the values* are readable by the agent, and so by a prompt injection; that is
  still the only option for non-HTTP services (IMAP/SMTP, SSH).
- **The agent can see a few credentials.** The Claude OAuth token, the gateway
  key, the One key and the internal secret are in its environment (or a child
  process's), because the CLI and its tools need them. A leak costs Claude usage
  and access to the `/internal` API, which can't mint logins or read hidden
  connector values. Rotate the OAuth token with `claude setup-token` if it
  leaks.
- **Some persistence is possible.** The agent's memory, its workspace (including
  a `.claude/` project settings directory there) and the skills it creates load
  into later sessions, so an injected instruction can outlive the turn that
  carried it. Built-in skills, rules and CLAUDE.md are out of its reach.
- **Network egress is open.** The engine can reach the internet and whatever
  shares its Docker networks. Don't attach it to a network with unauthenticated
  services you wouldn't want it to reach.
- **Sessions can't be revoked.** JWTs are valid for 30 days and logout only
  clears local storage. There's no password change endpoint yet; to invalidate
  every session, delete `jwt` from `agent/data/secrets.json` and restart.
- **Generated apps run on the same origin as the UI by default.** They need
  `allow-same-origin` for their own storage, which on a shared origin also means
  an app can read the Jarvis page and shares one `localStorage` namespace with
  it. Apps authenticate with their own scoped token rather than the account
  session, so a misbehaving app can proxy through connectors but can't reach the
  rest of the API — but it could still read the session out of the shared
  storage. `VITE_APPS_ORIGIN` serves apps from a separate hostname and closes
  this properly; it is worth doing if other people open your app links. Note
  that moving origin gives apps a fresh, empty `localStorage`, so anything they
  kept there starts over.
- **A "can reply" share link spends your Claude usage** and runs your agent.
  Give those out deliberately.

## Deployment advice

- Put Jarvis behind a reverse proxy with TLS. Don't publish the backend port.
- Set `TRUST_PROXY` correctly so rate limiting sees real client IPs.
- Don't mount the Docker socket into anything the agent can reach. If you give
  the agent a way to run `docker compose`, you have given it root on the host.
- Back up `agent/` — it holds the database, secrets, and the agent's files.
