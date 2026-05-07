---
name: add-connector
description: Add a new third-party integration (connector) to Jarvis — catalog entry, optional test/proxy, and companion skill. Use ONLY when the user explicitly asks to add or integrate a new service (e.g. "add a connector for Jira", "integrate Notion", "hook up service X"). Do NOT activate from ambiguous requests.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Add Connector Skill

You can extend Jarvis with a new connector — a catalog entry that lets the user save credentials in the UI, and (usually) a companion skill that uses those credentials.

## When to use

Only when the user explicitly asks to add a new integration. If unclear, ask: "Do you want me to wire up a new connector to Jarvis?"

## Architecture primer

- **Catalog** (`/jarvis/backend/src/connectors.ts`): hardcoded list of connectors. Each has `id`, `name`, `description`, `icon` (Lucide name), `fields` (what the UI shows), optional `test()`, optional `proxy`.
- **Secrets** are saved in the `connectors` DB table, not in `.env`.
- **Injection**: at Claude process spawn, all saved secrets are exported as env vars. Skills reference them as `$FOO` or `${FOO}` — the shell expands them.
- **Companion skill** (`/jarvis/agent/skills/<name>/SKILL.md`): tells you how to USE those env vars (curl commands, API patterns, etc.).

## Step-by-step

1. **Read `/jarvis/backend/src/connectors.ts`** — it's the source of truth. Look at `copyparty` as the canonical example (it shows fields + test + proxy).

2. **Add a catalog entry** in `CONNECTOR_CATALOG`:

```ts
{
  id: 'jira',                                          // lowercase, stable — used in URLs and DB
  name: 'Jira',
  description: 'Track issues and sprints',
  icon: 'SquareKanban',                                // Lucide icon name
  fields: [
    { key: 'JIRA_URL', label: 'Base URL', type: 'text', placeholder: 'https://you.atlassian.net' },
    { key: 'JIRA_EMAIL', label: 'Email', type: 'email' },
    { key: 'JIRA_TOKEN', label: 'API token', type: 'password' },
  ],
  test: async (s) => {
    // Return { ok: true, message: '...' } on success.
    // Use fetchWithTimeout() — already in the file.
  },
},
```

3. **Optional: `proxy` config** — add this if the connector serves content that the browser needs inline (images, PDFs, files referenced in chat messages). The backend will expose `/api/connectors/:id/proxy/*` that streams from the internal URL with the declared auth header. See the `copyparty` entry.

```ts
proxy: {
  baseUrlField: 'JIRA_URL',
  authHeader: { name: 'Authorization', valueField: 'JIRA_TOKEN' },  // or omit if no auth header needed
},
```

4. **Write the companion skill** at `/jarvis/agent/skills/<id>/SKILL.md`. Model it on an existing one (e.g. `linear/`, `gmail/`). Reference env vars directly (`$JIRA_TOKEN`), don't read the DB.

5. **Restart is automatic** — `tsx watch` reloads the backend on save. The new connector shows up in the Settings UI immediately. Remind the user to fill in credentials there.

## Guidelines

- **Don't edit `.env`** — credentials live in the DB, entered via the UI.
- **Match existing style** — look at sibling entries before writing yours.
- **Test functions should be fast** (≤5s) and return friendly messages. `fetchWithTimeout()` is already defined at the top of `connectors.ts`.
- **Icons**: pick from [lucide.dev/icons](https://lucide.dev/icons). Any valid Lucide name works.
- **Small steps** — write the catalog entry first, let the user confirm it appears in the UI and the test passes, THEN write the companion skill.
- **No frontend work needed** — the Settings UI reads the catalog dynamically.
