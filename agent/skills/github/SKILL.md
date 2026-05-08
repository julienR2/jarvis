---
name: github
description: Interact with GitHub repositories, issues, pull requests, and commits via the GitHub REST API. Use when the user mentions GitHub, repos, repositories, issues, PRs, pull requests, commits, releases, or asks to push/clone/fetch from GitHub.
allowed-tools: Bash, Read, Write
---

# GitHub Skill

Access GitHub via the REST API and via `git`/`gh` over HTTPS.

## Credentials

- **Token:** `${GITHUB_TOKEN}` (Personal Access Token, classic or fine-grained)
- **API base:** `https://api.github.com`
- **Git push URL pattern:** `https://x-access-token:${GITHUB_TOKEN}@github.com/<owner>/<repo>.git`

The token is also picked up automatically by the `gh` CLI when exported as `GH_TOKEN` (already done in this environment).

---

## REST API basics

All requests require these headers:

```bash
curl -s https://api.github.com/user \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28"
```

### Who am I

```bash
curl -s https://api.github.com/user \
  -H "Authorization: Bearer ${GITHUB_TOKEN}"
```

### List my repos

```bash
curl -s "https://api.github.com/user/repos?per_page=100&sort=updated" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}"
```

### List issues / PRs assigned to me

```bash
curl -s "https://api.github.com/issues?filter=assigned&state=open" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}"
```

### Create an issue

```bash
curl -s -X POST https://api.github.com/repos/OWNER/REPO/issues \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -d '{"title":"Bug: …","body":"Details…","labels":["bug"]}'
```

### Create a PR

```bash
curl -s -X POST https://api.github.com/repos/OWNER/REPO/pulls \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -d '{"title":"…","head":"feature-branch","base":"main","body":"…"}'
```

---

## Pushing code from inside the container

Set the remote with the embedded token, then `git push` works without prompting:

```bash
git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/OWNER/REPO.git"
git push origin main
```

For a one-off push without changing the remote:

```bash
git push "https://x-access-token:${GITHUB_TOKEN}@github.com/OWNER/REPO.git" HEAD:main
```

---

## Common use cases

| Task | Endpoint / command |
|---|---|
| List my open PRs | `GET /search/issues?q=is:pr+is:open+author:@me` |
| Find an issue by text | `GET /search/issues?q=…` |
| Comment on an issue/PR | `POST /repos/OWNER/REPO/issues/:n/comments` |
| Latest release of a repo | `GET /repos/OWNER/REPO/releases/latest` |
| Repo file contents | `GET /repos/OWNER/REPO/contents/PATH` |
| Push commits | `git push` with token-embedded URL |

## Notes

- Fine-grained tokens scope to specific repos — if a request returns 404 or 403, the token may not cover that repo.
- The Search API is rate-limited to 30 req/min. Regular endpoints: 5000 req/hour.
- `gh` CLI works too: `GH_TOKEN=${GITHUB_TOKEN} gh pr list --repo OWNER/REPO`.
