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
because Jarvis is an AI agent with a shell, write access to its own source code,
and whatever credentials you give it.

**The agent runs without asking permission.** Tool calls aren't gated behind
approval prompts — a cron firing at 7am has nobody to ask. In practice this
means the agent can run commands, edit its own code, and use every connector you
have configured, on its own initiative.

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
- **The agent doesn't get your login.** `JWT_SECRET`, `ADMIN_EMAIL` and
  `ADMIN_PASSWORD` are stripped from the subprocess environment.
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
  database file, or a login, can read them.
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
