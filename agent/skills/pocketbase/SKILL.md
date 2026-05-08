---
name: pocketbase
description: Read and write records in the PocketBase backend — financial data, custom collections, and admin operations. Use when the user mentions PocketBase, the financial database, transactions, accounts, or asks to query/update records in PocketBase collections.
allowed-tools: Bash, Read, Write
---

# PocketBase Skill

Self-hosted [PocketBase](https://pocketbase.io) backend running in the homelab network. Stores financial data and other custom collections.

## Credentials

- **Base URL (internal):** `${POCKETBASE_URL}` (typically `http://pocketbase:8080`)
- **Admin email:** `${POCKETBASE_EMAIL}`
- **Admin password:** `${POCKETBASE_PASSWORD}`

---

## Authenticate (superuser)

In PocketBase 0.23+, admins live in the `_superusers` system collection. Auth here gets a token with full access to every collection.

```bash
TOKEN=$(curl -s -X POST "${POCKETBASE_URL}/api/collections/_superusers/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"${POCKETBASE_EMAIL}\",\"password\":\"${POCKETBASE_PASSWORD}\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

All subsequent calls add `-H "Authorization: ${TOKEN}"`.

> Older PocketBase (≤0.22) used `/api/admins/auth-with-password`. If you're running an older version, swap the URL.

---

## List collections

```bash
curl -s "${POCKETBASE_URL}/api/collections" \
  -H "Authorization: ${TOKEN}"
```

## Read records

### List records in a collection

```bash
curl -s "${POCKETBASE_URL}/api/collections/COLLECTION/records?perPage=100" \
  -H "Authorization: ${TOKEN}"
```

### Filtered list (PocketBase filter syntax)

```bash
curl -s -G "${POCKETBASE_URL}/api/collections/transactions/records" \
  -H "Authorization: ${TOKEN}" \
  --data-urlencode 'filter=date >= "2026-02-01" && account = "bankinter"' \
  --data-urlencode 'sort=-date' \
  --data-urlencode 'perPage=200'
```

Filter operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `~` (LIKE), `!~`, `?=` (any-of for relations).

### Get one record by ID

```bash
curl -s "${POCKETBASE_URL}/api/collections/COLLECTION/records/RECORD_ID" \
  -H "Authorization: ${TOKEN}"
```

---

## Create / update / delete

### Create

```bash
curl -s -X POST "${POCKETBASE_URL}/api/collections/COLLECTION/records" \
  -H "Authorization: ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"field":"value"}'
```

### Update (partial)

```bash
curl -s -X PATCH "${POCKETBASE_URL}/api/collections/COLLECTION/records/RECORD_ID" \
  -H "Authorization: ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"field":"new value"}'
```

### Delete

```bash
curl -s -X DELETE "${POCKETBASE_URL}/api/collections/COLLECTION/records/RECORD_ID" \
  -H "Authorization: ${TOKEN}"
```

---

## Aggregations

PocketBase has no native aggregation API, but you can get all records and aggregate in Python:

```python
import os, requests
PB = os.environ["POCKETBASE_URL"]
auth = requests.post(f"{PB}/api/collections/_superusers/auth-with-password", json={
    "identity": os.environ["POCKETBASE_EMAIL"],
    "password": os.environ["POCKETBASE_PASSWORD"],
}).json()
token = auth["token"]

r = requests.get(f"{PB}/api/collections/transactions/records",
                 params={"perPage": 500, "filter": 'date >= "2026-02-01"'},
                 headers={"Authorization": token}).json()

total = sum(float(t["amount"]) for t in r["items"])
print(f"Sum: {total:.2f}")
```

For collections >500 rows, paginate via the `page` param (response includes `totalPages`).

---

## Common use cases

| Task | Endpoint |
|---|---|
| List records | `GET /api/collections/:name/records` |
| Filtered query | `GET /api/collections/:name/records?filter=…` |
| Create record | `POST /api/collections/:name/records` |
| Update record | `PATCH /api/collections/:name/records/:id` |
| Delete record | `DELETE /api/collections/:name/records/:id` |
| Schema introspection | `GET /api/collections` |

## Notes

- Cache the admin token if making many requests in the same session — re-authing every call is wasteful.
- Date fields are ISO 8601 strings (`"2026-05-08 00:00:00.000Z"`). Compare with `>=`, `<=` in the filter.
- For relation fields, use `expand=fieldName` on read requests to inline the related record.
