---
name: knowledge
description: Personal knowledge base for saving and retrieving things the user learns, watches, reads, or thinks about. Use when the user wants to remember something, save a note about a video/article/idea, recall something they saved before, or search their knowledge base. Also use when the user says "remember this", "save this", "I watched/read/found this", or asks "what did I save about X".
allowed-tools: Bash, Read, Write
---

# Knowledge Skill

A personal knowledge base stored as **markdown files in CopyParty** (`/knowledge/` folder). Each entry is a standalone `.md` file with YAML frontmatter — human-readable, portable, no lock-in.

## Storage layout

```
/knowledge/
  2026-05-25-attention-economy-video.md
  2026-05-20-surf-forecasting-article.md
  2026-05-18-thought-on-memory-systems.md
  ...
```

All entries live flat in `/knowledge/` (no subdirectories). File name format: `YYYY-MM-DD-slugified-title.md`.

## Entry format

```markdown
---
title: The Attention Economy
type: video
date: 2026-05-25
source: https://youtube.com/watch?v=...
tags: [psychology, media, attention]
---

Key points:
- Point one
- Point two

Open questions:
- Something I'm wondering about
```

### Field reference

| Field | Required | Values |
|-------|----------|--------|
| `title` | yes | Short descriptive title |
| `type` | yes | `video`, `article`, `thought`, `link`, `note`, `book`, `podcast`, `conversation`, `recipe`, `quote` |
| `date` | yes | `YYYY-MM-DD` (entry creation date) |
| `source` | no | URL or reference to the original |
| `tags` | yes | Array of lowercase keywords (2-5 tags) |

### Content guidelines

- Capture the user's own words and perspective, not a generic summary
- Include "Key points" and "Open questions" sections when relevant
- Keep context: why it mattered to the user, what they found interesting
- If the user provides a link, note what they said about it — don't just save the URL

---

## CopyParty access

```bash
AUTH="--cookie cppwd=${COPYPARTY_PASSWORD}"
BASE="${COPYPARTY_BASE_URL}"
```

---

## Saving a new entry

1. Parse the user's message to extract: title, type, source URL, tags, and content
2. Generate a slug from the title (lowercase, alphanumeric + hyphens, max 50 chars)
3. Build the markdown file with frontmatter
4. Upload to CopyParty

```bash
DATE=$(date +%Y-%m-%d)
SLUG="attention-economy-video"  # derived from title
FILE="knowledge/${DATE}-${SLUG}.md"

# Write content to temp file
cat > /tmp/knowledge-entry.md << 'ENTRY'
---
title: The Attention Economy
type: video
date: 2026-05-25
source: https://youtube.com/watch?v=abc
tags: [psychology, media, attention]
---

Key points:
- ...
ENTRY

# Upload to CopyParty
curl -s ${AUTH} -T /tmp/knowledge-entry.md "${BASE}/${FILE}"
rm -f /tmp/knowledge-entry.md
```

When saving, confirm to the user what was saved — show the title, type, tags, and a brief summary.

---

## Searching entries

### By keyword (full-text via grep on downloaded files)

```bash
# List all entries
ENTRIES=$(curl -s ${AUTH} "${BASE}/knowledge/?ls")

# Download and search (for small collections)
# Parse file list, download each, grep for keyword
echo "${ENTRIES}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for f in data.get('files', []):
    if f['href'].endswith('.md'):
        print(f['href'].split('/')[-1])
"
```

### By tag or type (parse frontmatter)

```bash
# Download an entry and extract frontmatter
FILE_CONTENT=$(curl -s ${AUTH} "${BASE}/knowledge/2026-05-25-attention-economy.md")
```

### Search strategy

For finding entries, use this approach:

1. **List all files** in `/knowledge/` via `?ls`
2. **Filter by date** from filenames (they start with YYYY-MM-DD)
3. **Download and scan frontmatter** of candidates for tag/type matching
4. **Full-text search**: download and grep content of likely matches

For small collections (<100 entries), downloading all and searching locally is fine. If it grows large, consider building a local index.

---

## Listing entries

### Recent entries

```bash
# List files sorted by name (most recent first since names start with date)
curl -s ${AUTH} "${BASE}/knowledge/?ls" | python3 -c "
import sys, json
data = json.load(sys.stdin)
files = [f for f in data.get('files', []) if f['href'].endswith('.md')]
files.sort(key=lambda f: f['href'], reverse=True)
for f in files[:10]:
    name = f['href'].split('/')[-1]
    print(name)
"
```

### By tag

Download recent entries, parse frontmatter, filter by tag.

---

## Reading an entry

```bash
curl -s ${AUTH} "${BASE}/knowledge/2026-05-25-attention-economy-video.md"
```

Display the content in a readable format. Show title, type, date, source, tags, then the body.

---

## Updating an entry

CopyParty PUT does not overwrite — it creates duplicates. To update:

1. Download the current content
2. Modify it
3. Delete the old file
4. Upload the new version

```bash
FILE="knowledge/2026-05-25-attention-economy-video.md"

# 1. Download
CONTENT=$(curl -s ${AUTH} "${BASE}/${FILE}")

# 2. Modify (in script or temp file)

# 3. Delete old
curl -s ${AUTH} -X POST -d "act=rm" "${BASE}/${FILE}"

# 4. Upload new
printf '%s\n' "${UPDATED}" | curl -s ${AUTH} -T - "${BASE}/${FILE}"
```

---

## Ingesting CopyParty files

The user may have existing notes, blog articles, or other files in CopyParty that they want in the knowledge base. Two approaches:

1. **Reference**: Save a knowledge entry that points to the CopyParty path (e.g., `source: copyparty:///blog/drafts/my-article.md`)
2. **Copy**: Download, reformat with frontmatter, upload to `/knowledge/`

Prefer referencing unless the user wants a curated summary.

---

## Slug generation

```bash
# Generate slug from title
SLUG=$(echo "The Attention Economy!" | \
  tr '[:upper:]' '[:lower:]' | \
  sed 's/[^a-z0-9]/-/g' | \
  sed 's/--*/-/g' | \
  sed 's/^-//;s/-$//' | \
  cut -c1-50)
```

---

## Quick reference

| User says | Action |
|-----------|--------|
| "remember this video about X" | Create entry (type: video) |
| "save this article" | Create entry (type: article) |
| "I was thinking about X" | Create entry (type: thought) |
| "what did I save about X" | Search by keyword |
| "show my recent notes" | List recent entries |
| "what videos have I saved" | List entries filtered by type: video |
| "update my note about X" | Find and modify entry |
| "anything tagged psychology?" | Search by tag |
