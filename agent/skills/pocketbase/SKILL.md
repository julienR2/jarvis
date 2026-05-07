---
name: pocketbase
description: Access financial data (bank accounts, balances, transactions) via PocketBase. Use when the user asks about bank accounts, balances, transactions, expenses, income, or anything finance-related.
allowed-tools: Bash, Read
---

# PocketBase Skill

Access the user's PocketBase instance to manage financial data (accounts, transactions).

## Config

- Base URL (inside Docker): `${POCKETBASE_INTERNAL_URL}` — use this for all server-side/curl calls
- Base URL (outside Docker / browser): `${POCKETBASE_PUBLIC_URL}` — use this in mini-apps and any client-side code
- Auth: `${POCKETBASE_EMAIL}` / `${POCKETBASE_PASSWORD}`
- Collections: `accounts`, `transactions`

## Authentication (always do this first)

```bash
TOKEN=$(curl -s -X POST ${POCKETBASE_INTERNAL_URL}/api/collections/_superusers/auth-with-password \
  -H "Content-Type: application/json" \
  -d '{"identity":"${POCKETBASE_EMAIL}","password":"${POCKETBASE_PASSWORD}"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
```

## Endpoints

### Read — Accounts

```bash
curl -s "${POCKETBASE_INTERNAL_URL}/api/collections/accounts/records" \
  -H "Authorization: $TOKEN"
```

### Read — Transactions

```bash
curl -s "${POCKETBASE_INTERNAL_URL}/api/collections/transactions/records?perPage=50&sort=-date" \
  -H "Authorization: $TOKEN"
```

### Create — New record

```bash
curl -s -X POST "${POCKETBASE_INTERNAL_URL}/api/collections/COLLECTION/records" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"field": "value"}'
```

### Update — Specific record by ID

```bash
curl -s -X PATCH "${POCKETBASE_INTERNAL_URL}/api/collections/COLLECTION/records/RECORD_ID" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"field": "new_value"}'
```

### Delete — Specific record by ID

```bash
curl -s -X DELETE "${POCKETBASE_INTERNAL_URL}/api/collections/COLLECTION/records/RECORD_ID" \
  -H "Authorization: $TOKEN"
```

---

## Usage

When the user asks about account balances, expenses, or income:

1. Authenticate to get TOKEN
2. Filter/format the relevant data and respond concisely

When the user asks to add, edit, or remove data:

1. Follow Safety Rules (see rules/safety.md)
2. Authenticate, fetch relevant record(s), confirm the operation, then execute
