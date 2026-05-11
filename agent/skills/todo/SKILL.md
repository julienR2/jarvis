---
name: todo
description: Manage the user's personal todo lists. Use when the user mentions todos, tasks, to-do, things to do, or asks to add/check/remove/complete a task. The todos live in CopyParty markdown files — NOT in the workspace memory todos.md.
allowed-tools: Bash, Read
---

# Todo Skill

The user has a todo app backed by **CopyParty markdown files** in the `/todos/` folder of their personal drive. When the user mentions adding, checking, completing, or removing a todo, interact with these files — not with `$WORKSPACE_DIR/memory/todos.md`.

## Architecture

- **App UI**: live at the app sidebar (conversation `9744a80b-106b-43d2-aa76-68a541954572`)
- **Storage**: CopyParty drive at `http://copyparty:3923`, folder `/todos/`
- **Access**: via the Jarvis backend connector proxy at `/api/connectors/copyparty/proxy`
- **Auth**: cookie-based, handled by the proxy — no manual auth needed for GET; JWT token required for PUT/DELETE

Each list is a separate `.md` file: `main.md`, `work.md`, etc. The default list is **`main.md`**.

## File format

```
- [ ] Todo title
- [x] Completed todo
- [ ] [high] Urgent task
- [ ] [medium] Medium priority task
- [ ] Todo with description - this is the description text
- [ ] [high] Urgent with desc - details here
```

Rules:
- `[ ]` = open, `[x]` = done
- Priority: `[high]`, `[medium]`, or omitted (default/gray)
- Description separator: ` - ` (single hyphen with spaces), placed after the title
- Links in title/desc use markdown: `[label](url)` — the app auto-linkifies them

## Reading a list

```bash
# List all todo files
curl -s "${BACKEND_URL}/api/connectors/copyparty/proxy/todos/?ls" | \
  python3 -c "import sys,json; [print(f['href'].split('/')[-1]) for f in json.load(sys.stdin).get('files',[]) if f['href'].endswith('.md')]"

# Read a specific list (no auth needed)
curl -s "${BACKEND_URL}/api/connectors/copyparty/proxy/todos/main.md"
```

## Adding a todo

Read the current file, append the new line, then delete-and-reupload (PUT does NOT overwrite in CopyParty — it creates a duplicate).

```bash
TOKEN=$(cat /jarvis/agent/data/secrets.json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('claudeOauthToken',''))" 2>/dev/null || echo "")
FILE="todos/main.md"

# 1. Read current content
CONTENT=$(curl -s "${BACKEND_URL}/api/connectors/copyparty/proxy/${FILE}")

# 2. Append new line
NEW_LINE="- [ ] The new todo title"
# With priority:     "- [ ] [high] The new todo title"
# With description:  "- [ ] Title - description text"

UPDATED="${CONTENT}
${NEW_LINE}"

# 3. Delete then upload
curl -s -X DELETE "${BACKEND_URL}/api/connectors/copyparty/proxy/${FILE}" \
  -H "Authorization: Bearer ${TOKEN}"

printf '%s\n' "${UPDATED}" | curl -s -X PUT "${BACKEND_URL}/api/connectors/copyparty/proxy/${FILE}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: text/plain; charset=utf-8" \
  --data-binary @-
```

## Marking a todo done / removing a todo

Use Python to parse and modify the lines, then delete-and-reupload the same way:

```bash
# Mark done: replace `- [ ]` with `- [x]` on the matching line
# Remove: filter out the matching line
# Always delete-then-PUT after modifying
```

## Priority values

| User says | File value | Checkbox color |
|-----------|-----------|----------------|
| high / urgent / important | `[high]` | Red border/fill |
| medium / normal | `[medium]` | Yellow border/fill |
| low / default / none | (omit) | Gray border |

## Which list to use

- Default: **`main.md`**
- If the user specifies a list name (e.g. "work todos", "shopping list"), use or create `<name>.md`
- List file name: `<name>.lower().replace(non-alnum, '-') + '.md'`

## Creating a new list

```bash
TOKEN=...
curl -s -X PUT "${BACKEND_URL}/api/connectors/copyparty/proxy/todos/newlist.md" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: text/plain; charset=utf-8" \
  --data-binary ""
```

## Getting the JWT token

The token is needed for write operations (PUT, DELETE):

```bash
TOKEN=$(node -e "
const db = require('/jarvis/backend/node_modules/better-sqlite3')('/jarvis/agent/data/jarvis.db');
// Token is in the HTTP request — not stored. Use secrets.json for OAuth token.
" 2>/dev/null)

# Simpler: read from secrets.json (works when using Claude OAuth)
TOKEN=$(python3 -c "
import json
s = json.load(open('/jarvis/agent/data/secrets.json'))
print(s.get('claudeOauthToken',''))
" 2>/dev/null)
```

If the token approach fails, the user can also provide the JWT from their browser session. Alternatively, ask them to add via the app UI.

## Quick summary for common requests

| User says | Action |
|-----------|--------|
| "add a todo: X" | Append `- [ ] X` to `main.md` |
| "add urgent todo: X" | Append `- [ ] [high] X` to `main.md` |
| "what are my todos" | Read and display `main.md` |
| "mark X as done" | Find matching line, change `[ ]` to `[x]`, reupload |
| "remove todo X" | Filter out the matching line, reupload |
| "add to my work list: X" | Append to `work.md` (create if needed) |
