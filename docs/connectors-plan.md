# Connectors — Design Sketch

Separate credentials from skills. A curated catalog of third-party integrations, connected via API key or OAuth, with tokens stored in SQLite and injected as env vars into the Claude subprocess at runtime.

Inspired by Cerebro's connector model (`cerebro/docs/connectors/specs.md`, `cerebro/services/api/pkg/connector/registry.go`), simplified for single-user Jarvis (no org/admin split, no at-rest encryption — see "Why no encryption" below).

## Why

Today skills mix two concerns:
- **Behavior** — what the agent does (prompt, curl flow, decision logic)
- **Credentials** — how to authenticate (password, token, URL)

This coupling has three problems:
1. Credentials live as `${VAR}` references to `.env`, so adding a new integration means editing `.env.example` + restarting the container
2. No visibility: forkers have no way to know what's connected or what's needed
3. Skills are harder to share — personal creds risk leaking into git

Connectors fix this by making credentials first-class: connect via UI, skills just declare `required_connectors`.

## Model

```
┌─────────────────────┐    declares "requires"     ┌─────────────────────┐
│  Skill (SKILL.md)   │ ─────────────────────────> │  Connector          │
│  behavior only      │                            │  credentials only   │
└─────────────────────┘                            └─────────────────────┘
         │                                                   │
         │ uses $GMAIL_APP_PASSWORD                          │ stores token
         │ at runtime                                        │ encrypted in DB
         v                                                   v
┌───────────────────────────────────────────────────────────────────────┐
│  Backend injects connector secrets into claude subprocess env         │
└───────────────────────────────────────────────────────────────────────┘
```

## Backend

### Connector registry

Hardcoded TypeScript module. Each connector is a static definition — adding a new connector is a code change, not a DB migration.

File: `backend/src/connectors/registry.ts`

```ts
type AuthMethod = 'api_key' | 'multi_field' | 'oauth';

export interface Connector {
  id: string;                 // 'gmail', 'pocketbase', 'notion'
  name: string;               // 'Gmail'
  description: string;
  icon: string;               // key the frontend resolves to SVG/emoji
  auth_method: AuthMethod;
  secret_names: string[];     // env vars provided: ['GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD']
  fields?: Field[];           // for api_key / multi_field: what the user enters
  oauth?: OAuthConfig;        // for oauth only
}

interface Field {
  name: string;               // matches a secret_name
  label: string;              // 'Email', 'App Password'
  type: 'text' | 'password' | 'url';
  placeholder?: string;
  help?: string;              // "Generate at https://myaccount.google.com/apppasswords"
}

interface OAuthConfig {
  authorize_url: string;
  token_url: string;
  scopes: string[];
  client_id_env: string;      // env var holding OAuth app's client_id
  client_secret_env: string;
  extra_params?: Record<string, string>;
}

export const Registry: Connector[] = [ /* ... see catalog below ... */ ];
```

### Storage

New table in SQLite:

```sql
CREATE TABLE connectors (
  connector_id   TEXT PRIMARY KEY,          -- matches Registry[].id
  secrets_json   TEXT NOT NULL,             -- JSON: { GMAIL_ADDRESS: '...', GMAIL_APP_PASSWORD: '...' }
  metadata_json  TEXT,                      -- non-secret info: account email, workspace name, scopes
  connected_at   INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
```

### Why no encryption

Cerebro encrypts because it's multi-user — one team member shouldn't be able to read another's tokens by querying the DB. Real threat model.

Jarvis is single-user, self-hosted, you-are-the-admin. The only realistic threats are filesystem leak (host compromised, backup exposed) or accidental disclosure (DB committed to git). Encryption with a key colocated alongside the DB doesn't help against either — anyone who reads the DB can also read the key. True at-rest encryption requires the key to live somewhere unreachable from the DB (passphrase typed at startup, hardware key, remote KMS), none of which make sense for self-hosted single-user.

So: store secrets as plain JSON. Rely on:
- File perms (`chmod 600 data/jarvis.db`)
- `data/` already gitignored
- HTTPS for UI / API

If you ever go multi-user or want passphrase-unlocked secrets, add encryption then.

### API endpoints

All behind existing JWT auth.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/connectors` | List catalog + connection status for each |
| `GET` | `/api/connectors/:id` | Get details (metadata, which skills use it) |
| `POST` | `/api/connectors/:id` | Save api_key / multi_field creds (body = field values) |
| `DELETE` | `/api/connectors/:id` | Disconnect (delete row) |
| `GET` | `/api/oauth/authorize/:id` | Generate OAuth URL with state, return `{ url }` |
| `GET` | `/api/oauth/callback/:id` | OAuth callback — exchange code, store token, redirect to `/connectors?connected=:id` |

### Secret injection at runtime

Currently `backend/src/claude.ts` spawns `claude` as subprocess inheriting process env. Change: before spawn, query all connectors and build env:

```ts
function buildConnectorEnv(db: Database): Record<string, string> {
  const rows = db.prepare('SELECT secrets_json FROM connectors').all();
  const env: Record<string, string> = {};
  for (const row of rows) {
    Object.assign(env, JSON.parse(row.secrets_json));
  }
  return env;
}

const proc = spawn('claude', args, {
  env: { ...process.env, ...connectorEnv, JARVIS_CONVERSATION_ID: id }
});
```

`.env` can still provide defaults (connector values override). This preserves backwards compat during migration.

### Skill metadata update

Add optional `required_connectors` to SKILL.md frontmatter:

```yaml
---
name: gmail
description: Read, search, and send Gmail emails...
allowed-tools: Bash, Read, Write
required_connectors: [gmail]
---
```

Backend reads frontmatter from `agent/skills/*/SKILL.md` on startup, builds a map `connector_id → skill_ids`. Exposed via `GET /api/connectors/:id` so the UI can show "used by: Gmail skill".

Skills can continue using `$GMAIL_APP_PASSWORD` at runtime — the env is just injected from a different source now.

## Frontend

### Page

`/connectors` — new top-level route, next to existing crons/webhooks. Add to sidebar under the "Spaces" group.

Card grid, 2-3 columns responsive. Each card:
- Icon + name + description
- Status badge: **Connected** (green) / **Available** (neutral) / **Unavailable** (gray, if OAuth envs missing)
- Action button: **Connect** / **Manage**

### Dialogs

**API key / multi-field connect dialog**:
- Form with fields from `connector.fields`
- Per-field help text (e.g. "Generate at https://myaccount.google.com/apppasswords")
- POST to `/api/connectors/:id` on submit

**OAuth connect**:
- Click "Connect" → call `GET /api/oauth/authorize/:id` → `window.location = url`
- Provider redirects to `/api/oauth/callback/:id` → backend stores token → redirects to `/connectors?connected=:id`
- Frontend shows toast on arrival

**Manage dialog** (connected):
- Show account info from `metadata_json` (e.g. "connected as user@example.com")
- Show which skills use this connector
- **Reconnect** / **Disconnect** buttons

## Launch catalog

Convert current Jarvis skills with credentials into connectors:

| Connector | Auth | Secrets | Notes |
|-----------|------|---------|-------|
| `gmail` | multi_field | `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD` | App password link in help text |
| `pocketbase` | multi_field | `POCKETBASE_INTERNAL_URL`, `POCKETBASE_PUBLIC_URL`, `POCKETBASE_EMAIL`, `POCKETBASE_PASSWORD` | |
| `copyparty` | multi_field | `COPYPARTY_INTERNAL_URL`, `COPYPARTY_PUBLIC_URL`, `COPYPARTY_PASSWORD` | Shared by `drive` + `todo` skills |
| `imagerouter` | api_key | `IMAGEROUTER_API_KEY` | |
| `surf` | multi_field | `SURF_LATITUDE`, `SURF_LONGITUDE`, `SURF_SPOT_NAME` | Could be config rather than connector; borderline |

Future OAuth connectors (when/if you add skills for them):
- `notion`, `google_calendar`, `google_drive`, `slack`, `linear`

## Phasing

**Phase 1 — Backend foundation** (no UI yet)
1. Add `connectors` table migration
2. Implement `backend/src/connectors/registry.ts`
3. Implement REST + OAuth endpoints
4. Wire secret injection into `claude.ts` subprocess spawn
5. Parse `required_connectors` from SKILL.md on startup
6. Seed initial connectors from `.env` values (one-time migration script)

**Phase 2 — Frontend**
1. New `ConnectorsPage.tsx` with card grid
2. `ApiKeyConnectDialog.tsx` / `MultiFieldConnectDialog.tsx`
3. `ConnectorManageDialog.tsx`
4. Add `/connectors` route, sidebar entry
5. OAuth redirect flow handling (query params, toast)

**Phase 3 — Skill migration**
1. Add `required_connectors: [...]` to each skill that needs creds
2. Remove `.env` skill-credential entries from `.env.example` (keep `JWT_SECRET`, `INTERNAL_SECRET`, `CLAUDE_CODE_OAUTH_TOKEN`)
3. Update `.env.example` doc to point users to `/connectors`

**Phase 4 — Nice-to-haves** (later)
- Token refresh automation for OAuth connectors with short-lived tokens
- Per-skill connector status indicator in a skills list UI
- Import/export connectors as encrypted JSON (for backup/restore)
- Connector "test" button (verifies the credentials actually work)

## Open questions

- **Jarvis is single-user** — skip Cerebro's `Scope: personal | org_wide` entirely. Everything is personal to the one user.
- **Fallback to `.env`** — do we want `.env` to remain a valid way to set credentials for headless/CI setups? (Probably yes — simplest override.)
- **Migration of existing users** — Phase 1 step 6 should read values from `process.env` and auto-insert as connector rows on first startup after the table exists. Idempotent: skip if row already exists.
- **Connector catalog location** — pure code (TypeScript module) is simplest. YAML is more declarative (Cerebro uses Go structs, same idea). Go with TS for now, refactor if catalog grows.

## Files to create (Phase 1)

```
backend/src/
├── connectors/
│   ├── registry.ts              # hardcoded catalog
│   ├── oauth.ts                 # OAuth state/token exchange
│   └── service.ts               # CRUD + injection
├── routes/
│   ├── connectors.ts            # /api/connectors/*
│   └── oauth.ts                 # /api/oauth/*
└── db.ts                        # add connectors table migration
```

## Verification plan

- Unit test: registry lookup + required_connectors parsing from SKILL.md
- Integration: POST api_key → DB row created → spawn claude → env has the secret
- Manual: connect Notion via OAuth, verify redirect → callback → DB row → token visible in skill run
- Manual: disconnect → DB row gone → skill run doesn't get the var
- Migration: existing user with `GMAIL_APP_PASSWORD` in `.env` → restart → auto-inserted as connector row
