# The demo instance

A second Jarvis running from **this same checkout**, with its own agent
directory, used to produce screenshots and the demo GIF without anything
personal in frame.

```bash
bash demo/demo.sh seed     # once
bash demo/demo.sh up       # → http://localhost:5273
```

Login is printed by `seed` (`demo@jarvis.local` + a generated password), and
lives in `demo/.env`.

Everything the demo owns is inside this folder: the compose override, the
script, and `instance/` (gitignored) holding its entire state. Delete `demo/`
and the demo is gone, with no trace anywhere else in the repo.

## What is shared and what is not

| | |
|---|---|
| Shared, read-only | the source tree — same code, no second clone, no drift from what ships |
| Its own | `instance/agent`: SQLite DB, conversations, connectors, crons, memory, uploads |
| Its own | `.env` — fresh JWT and internal secrets, its own admin account |
| Its own | ports (5273 / 3105) and Docker network |
| Borrowed | your `CLAUDE_CODE_OAUTH_TOKEN`, so the demo boots into a working chat |

Connector credentials live in the database, not in the code, so the demo starts
with none. That is the whole privacy argument: a fresh DB cannot leak a
conversation, a mailbox, or a token that was never in it.

## Read-only source

The demo mounts the repo `:ro`. A demo conversation asking Jarvis to *"change
your interface"* gets a permission error instead of editing your working tree
and rebuilding both stacks.

It can still browse the code and read diffs — the Code page works — it just
cannot write or commit. So self-editing is the one flow you can't screenshot
here; do that on your own instance, where you'd be reviewing the diff anyway.

If `npm install` ever refuses to run against the read-only mount, the escape
hatch is `DEMO_SOURCE_MODE=rw bash demo/demo.sh up` — and then the caveat above
becomes real again.

## Letting Jarvis drive it

Jarvis runs in a container and reaches the host only through published ports.
Bound to loopback (the default) the demo is invisible to it. To let Jarvis open
the demo and take the screenshots itself:

```bash
DEMO_BIND_ADDR=0.0.0.0 bash demo/demo.sh up
```

That publishes 5273/3105 on every interface, LAN included, for as long as the
demo is up. It's a throwaway instance with its own password, but bring it back
to loopback when you're done:

```bash
bash demo/demo.sh down && bash demo/demo.sh up
```

## Starting over

```bash
bash demo/demo.sh reset    # wipes instance/, re-seeds, keeps demo/.env
```

Cheap enough that a bad demo conversation is never worth editing around — wipe
it and redo the take.
