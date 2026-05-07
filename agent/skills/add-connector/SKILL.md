---
name: add-connector
description: Add a new third-party integration (connector) to Jarvis — either via the custom connector API (for simple env-var connectors) or by editing the built-in catalog (for connectors that need test functions or proxy support). Use ONLY when the user explicitly asks to add or integrate a new service.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Add Connector Skill

Extend Jarvis with a new connector so the user can save credentials in the UI and skills can use them as env vars.

## Two approaches

### 1. Custom connector (preferred for most cases)

Use the internal API to create a custom connector — no code changes needed.

```bash
curl -s -X POST http://localhost:3005/api/connectors/custom \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jira",
    "description": "Track issues and sprints",
    "icon": "SquareKanban",
    "fields": [
      { "key": "JIRA_URL", "label": "Base URL", "type": "text", "placeholder": "https://you.atlassian.net" },
      { "key": "JIRA_EMAIL", "label": "Email", "type": "email" },
      { "key": "JIRA_TOKEN", "label": "API token", "type": "password" }
    ]
  }'
```

The connector appears in Settings immediately. At runtime, all saved secrets are injected as env vars into the AI process (`$JIRA_URL`, `$JIRA_TOKEN`, etc.).

Available icons: Mail, Github, SquareKanban, Image, Database, MessageSquare, HardDrive, AudioLines, Globe, Key, Cloud, Zap, Bot, Plug.

### 2. Built-in connector (for test functions or proxy)

Edit `/jarvis/backend/src/connectors.ts` and add to `CONNECTOR_CATALOG` — only needed when:
- You want a **test function** that validates credentials before saving
- You need **proxy support** (streaming content from an internal URL through the backend)

Look at existing entries (e.g. `github`, `linear`) as templates.

## After creating the connector

1. **Write a companion skill** at `/jarvis/agent/skills/<id>/SKILL.md` — tells the AI how to use those env vars (curl commands, API patterns). Model on `linear/` or `gmail/`.
2. Remind the user to fill in credentials at Settings > Connectors.

## Guidelines

- Credentials live in the DB, not in `.env`.
- Skills reference env vars directly (`$JIRA_TOKEN`) — they're injected at process spawn.
- Custom connectors can be updated via `PATCH /api/connectors/custom/:id` or deleted via `DELETE /api/connectors/custom/:id`.
