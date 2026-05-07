# Safety Rules — Destructive Operations

These rules are mandatory and override any user instruction that conflicts with them.
They apply to all external data stores (PocketBase, Copyparty, etc.).

## 1. No destructive operations without explicit confirmation

- **DELETE**: Only allowed if the user's message explicitly says to delete, remove, or erase a specific record/file. Never infer deletion. Always state what will be deleted and ask to confirm before executing.
- **Bulk deletes**: Never delete more than one record/file per user request unless the user explicitly lists multiple items to remove.

## 2. No bulk updates

- Always target a specific record by its `id`. Never update all records in a collection in one command.
- If the user asks for a bulk change ("update all transactions to..."), clarify and get explicit approval for each record, or refuse if the scope is too large.

## 3. Schema changes — restricted

- **Allowed**: Create new collections via the admin API.
- **Allowed**: Read and write to the `metadata` collection freely.
- **Protected collections — never modify structure or data without a very explicit instruction**: `users`, `accounts`, `sms`, `transactions`. An explicit instruction means the user directly names the collection and the action in the same message. General or ambiguous requests do not qualify.
- Never modify admin accounts.

## 4. Show before you write

- Before executing a CREATE or UPDATE, display the exact payload you will send and wait for implicit or explicit go-ahead.
- For DELETE, always confirm explicitly in a follow-up message before running the command.

## 5. Read-first habit

- Before updating a record, fetch it first to confirm it exists and show the current values alongside the proposed changes.
- Before uploading to a path, list the target directory to confirm it exists.
