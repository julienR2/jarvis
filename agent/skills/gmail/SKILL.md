---
name: gmail
description: Read, search, and send Gmail emails. Use when the user mentions email, inbox, Gmail, or asks to check/send messages.
allowed-tools: Bash, Read, Write
---

# Gmail Skill

Access Gmail via IMAP (read/search) and SMTP (send).

## Credentials

Uses the **`gmail`** connector → sets `$GMAIL_ADDRESS`, `$GMAIL_APP_PASSWORD`. Load them per *Connectors* in CLAUDE.md, in the same shell block as the commands that use them.

- **IMAP:** `imaps://imap.gmail.com:993`
- **SMTP:** `smtp://smtp.gmail.com:587` (STARTTLS)

---

## Read / Search emails (IMAP via curl)

### List latest emails in INBOX

```bash
curl -s --url "imaps://imap.gmail.com:993/INBOX" \
  --user "${GMAIL_ADDRESS}:${GMAIL_APP_PASSWORD}" \
  -X "FETCH 1:10 (ENVELOPE)"
```

### Search unread emails

```bash
curl -s --url "imaps://imap.gmail.com:993/INBOX" \
  --user "${GMAIL_ADDRESS}:${GMAIL_APP_PASSWORD}" \
  -X 'SEARCH UNSEEN'
```

### Fetch a specific message by UID

```bash
curl -s --url "imaps://imap.gmail.com:993/INBOX;UID=<uid>" \
  --user "${GMAIL_ADDRESS}:${GMAIL_APP_PASSWORD}" \
  -X "UID FETCH <uid> (BODY[])"
```

---

## Better approach: Python script

For anything beyond simple listing, use Python (available in the container):

```python
import imaplib, email

GMAIL = "${GMAIL_ADDRESS}"
APP_PW = "${GMAIL_APP_PASSWORD}"

mail = imaplib.IMAP4_SSL("imap.gmail.com")
mail.login(GMAIL, APP_PW)
mail.select("INBOX")

# Search — e.g. unseen
status, data = mail.search(None, "UNSEEN")
uids = data[0].split()

for uid in uids[-10:]:  # last 10
    _, msg_data = mail.fetch(uid, "(RFC822)")
    msg = email.message_from_bytes(msg_data[0][1])
    print(msg["Subject"], "|", msg["From"])

mail.logout()
```

Run with: `python3 /tmp/gmail_read.py`

---

## Send email (SMTP via Python)

```python
import smtplib
from email.mime.text import MIMEText

GMAIL = "${GMAIL_ADDRESS}"
APP_PW = "${GMAIL_APP_PASSWORD}"

msg = MIMEText("Body here")
msg["Subject"] = "Subject here"
msg["From"] = GMAIL
msg["To"] = "recipient@example.com"

with smtplib.SMTP("smtp.gmail.com", 587) as smtp:
    smtp.starttls()
    smtp.login(GMAIL, APP_PW)
    smtp.send_message(msg)
```

---

## Common use cases

| Task | Method |
|---|---|
| List unread emails | IMAP SEARCH UNSEEN |
| Read full email body | IMAP FETCH by UID |
| Search by subject/sender | IMAP SEARCH with criteria |
| Send an email | SMTP with MIMEText |
| List folders/labels | IMAP LIST |

## Notes

- Gmail folders use special names: `[Gmail]/Sent Mail`, `[Gmail]/Trash`, `[Gmail]/All Mail`, `[Gmail]/Starred`
- Spaces in app password are fine — Gmail ignores them
- Always close the IMAP connection after use (`mail.logout()`)
