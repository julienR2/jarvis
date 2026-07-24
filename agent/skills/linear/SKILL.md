---
name: linear
description: Access Linear issues, sprints, and generate daily standups via the Linear GraphQL API. Use when the user mentions Linear, issues, tickets, sprint, standup, daily update, or in-progress tasks.
allowed-tools: Bash
---

# Linear Skill

Access Linear via the GraphQL API.

## Credentials

Uses the **`linear`** connector → sets `$LINEAR_API_KEY`. Load it per *Connectors* in CLAUDE.md, in the same shell block as the commands that use it.

- **Endpoint:** `https://api.linear.app/graphql`

## How to query

Use `curl` with the Authorization header:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ ... }"}'
```

---

## Common queries

### Get current user

```graphql
{ viewer { id name } }
```

### Issues currently in progress (assigned to me)

```graphql
{
  viewer {
    assignedIssues(filter: { state: { type: { in: ["started", "inProgress"] } } }) {
      nodes { identifier title state { name } url }
    }
  }
}
```

### Issues completed on a specific date (e.g. yesterday)

Replace dates with ISO 8601 format (`YYYY-MM-DDT00:00:00.000Z`):

```graphql
{
  viewer {
    assignedIssues(filter: { completedAt: { gte: "2026-04-16T00:00:00.000Z", lte: "2026-04-16T23:59:59.999Z" } }) {
      nodes { identifier title state { name } completedAt }
    }
  }
}
```

### All issues assigned to me (any state)

```graphql
{
  viewer {
    assignedIssues {
      nodes { identifier title state { name } priority updatedAt }
    }
  }
}
```

### Issues by team

```graphql
{
  teams { nodes { id name } }
}
```

```graphql
{
  team(id: "TEAM_ID") {
    issues(filter: { assignee: { isMe: { eq: true } } }) {
      nodes { identifier title state { name } }
    }
  }
}
```

---

## Daily standup format (French)

When generating a daily standup, use this format:

```
Hello

Hier :
- [TSH-XXXX] Description de la tâche terminée

Aujourd'hui :
- [TSH-XXXX] Description de la tâche en cours
- [TSH-XXXX] Description de la tâche en review
```

- **Hier** = issues completed the previous working day (`completedAt` filter)
- **Aujourd'hui** = issues currently in progress or in review (`state.type` = started/inProgress)
- Today's date is always available as `currentDate` in the system context
