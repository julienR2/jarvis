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

The three services run `npm ci` here rather than the base `npm install`:
install wants to rewrite `package-lock.json` and dies with `EROFS` against a
read-only mount, while `ci` installs the locked versions and never writes the
lockfile. That also pins the demo to exactly the dependencies that ship, and
keeps `git status` clean while the demo runs.

If something else ever refuses to run against the read-only mount, the escape
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

## Recording

Everything the README and the landing page show — `docs/demo.gif` and the
`docs/screenshot-*.png` set — is regenerated from here. The full run:

```bash
bash demo/demo.sh up                    # the instance being filmed
node demo/record/seed.mjs --prune       # sidebar, crons, webhooks, connectors
node demo/record/content.mjs            # real agent turns (slow, costs tokens)
bash demo/record/shots.sh               # → out/shots/{dark,light}/*.png
bash demo/record/tour.sh                # → out/demo.gif + demo.webm/.mp4
THEME=light bash demo/record/tour.sh    # → out/demo-light.*
bash demo/record/publish.sh --write     # → docs/
```

| | |
|---|---|
| `seed.mjs` | Fills the instance over the API — sections, chats, crons, webhooks, connectors, plugin marketplace. Instant and idempotent. `--prune` also drops rows no longer in its lists (never one with messages). `--fresh` wipes everything first. |
| `content.mjs` | Asks the agent real questions, so the chat, the generated apps and the generated image on screen are things that actually ran. Slow and costs tokens; skips conversations that already have content unless you pass `--force`, and `--only <substring>` redoes just one. |
| `shots.sh` | Screenshots every page in **both themes** at 2560×1600 into `out/shots/{dark,light}/`. |
| `tour.sh` | Crossfades those stills into a GIF **and** a webm/mp4. `THEME=light` for the light set. Knobs: `WIDTH` (GIF), `VIDEO_W`, `HOLD`, `FADE`, `FPS`, `COLORS`. |
| `publish.sh` | Copies the lot into `docs/` under the names the README and `site/build.sh` expect. Dry-run unless `--write`. |
| `record.sh` | The other kind of take: a live screen recording of one conversation being typed and answered. `CLEAN=1` empties the sidebar first; knobs `SPEED`, `GIF_WIDTH`, `FPS`, `COLORS`, `KEEP_VIDEO=1`. |

The tour is crossfaded stills rather than one continuous recording: each page
gets a predictable moment on screen, re-shooting one page doesn't mean
re-performing the whole tour, and the file ends up a fraction of the size.
Edit `SCENES` in `tour.sh` to change the order, `PAGES` in `scenes.mjs` to
change what is captured, and the `SCRIPT` array in `record.mjs` for the live
take.

Screenshots are taken with secrets redacted **in the page**: the demo borrows
your real `CLAUDE_CODE_OAUTH_TOKEN` so it boots into a working chat, and the
Connection page prints a masked form of it — real suffix and all. `scenes.mjs`
rewrites that text to an obvious placeholder before the shutter. Nothing stored
changes, so the shot stays reproducible.

### Two themes, two formats, retina

Every page is shot in both themes, because the README and the landing page swap
their images with the reader's: a dark screenshot on a light page is the thing
that always looks broken. The README uses `<picture>` with a
`prefers-color-scheme` source; the site swaps a CSS class.

Screenshots are published at their captured 2560×1600 and laid out at 1280 CSS
px, so they stay sharp on a high-DPI screen.

The tour ships twice over. The **GIF** is for the README, where GitHub will not
reliably play a repo-relative `<video>`. The **webm/mp4** is for the site, and
is the better asset by a distance — at 1920×1200 it is around 750 KB where the
equivalent GIF is over five megabytes. `site/app.js` sets the video's sources,
because `<source media>` is ignored on `<video>` and the theme swap has to be
scripted.

### The Browser page

`DEMO_BROWSER=1` starts the optional headful Chromium alongside the demo, so
Settings → Browser has something real behind it. It costs about a gigabyte of
RAM, which is why it is opt-in.

It is **not** in the screenshot set, and `scenes.mjs` deliberately skips it. The
page embeds the Chromium container's own client, which streams the screen over
WebRTC, and that stream never negotiates inside the capture browser — the shot
is a "Waiting for stream…" placeholder however long you wait. (Not a codec gap:
that Chromium reports H.264 for both `<video>` and WebRTC.) Two things are worth
knowing if you go near it:

- The client refuses to run outside a **secure context**. `localhost` counts as
  one and so does HTTPS behind a proxy, but plain `http://<lan-ip>:5173` does
  not — there it renders "requires a secure connection" instead of a browser.
  That is why `shots.sh` uses host networking and `localhost` rather than
  joining the Compose network.
- The backend's proxy comments describe **KasmVNC**, but the image now ships
  selkies and WebRTC. The upstream changed under the code.

Shoot that page by hand from a real browser if you want it in the set.

### Why the browser runs in a container

Two stages, in two places, for reasons worth knowing before you move them:

- **The browser runs in a container.** Headless Chromium needs GTK/ATK system
  libraries, and `playwright install-deps` only knows how to install those on
  Debian/Ubuntu — on any other host distro a local run dies with
  `libatk-1.0.so.0: cannot open shared object file`. The pinned image also fixes
  the browser build, so the framing can't shift under you. It joins the demo's
  own Compose network and reaches it as `frontend:5173`, so this works with the
  demo bound to loopback.
- **ffmpeg runs on the host.** The image ships only Playwright's private ffmpeg
  for video capture, not one on `PATH` with the palette filters.

`out/` is gitignored: copy the take you want out of it and commit that, rather
than the whole scratch pile.

Note that the demo runs the **working tree**, not `HEAD` — that is the point of
the shared mount, but it does mean an in-progress edit is what gets filmed.

Conversation titles are normally generated by `backend/src/titles.ts`, whose
prompt is French. `seed.mjs` sidesteps that by creating each conversation with
a title already set: auto-titling only fires on the literal title
`New conversation`, so a seeded chat keeps the English one it was given. A
conversation you start by hand during a take will still be titled in French.

## Starting over

```bash
bash demo/demo.sh reset    # wipes instance/, re-seeds, keeps demo/.env
```

Cheap enough that a bad demo conversation is never worth editing around — wipe
it and redo the take.
