---
name: browser
description: Use the headful Chromium the user can watch and click, instead of the default headless browser. Use when a page is captcha-walled, shows a "verifying your device" interstitial, returns 403 or "unusual traffic", needs a login or a cookie banner dismissed, or when the user asks to use the visible browser.
allowed-tools: Bash, Read
---

# The two browsers

| | `mcp__playwright__*` (default) | `mcp__browser__*` (this skill) |
|---|---|---|
| Mode | headless, profile wiped every run | headful Chromium, persistent profile |
| User can intervene | no | yes — Settings → Browser, phone included |
| Fingerprint | obviously automated | attaches over CDP to a normally-launched browser: no `navigator.webdriver`, no `--enable-automation` |

Use the default for ordinary fetching. Switch to `mcp__browser__*` the moment a site
pushes back: captcha, "verifying your device", `403`, an endless challenge redirect, or
a page needing a logged-in session. Don't burn three retries on the headless one first.

## If the headful browser isn't there

It's optional and may not be running — `mcp__browser__*` tools simply won't exist.
Don't improvise a workaround; tell the user it needs starting:

```
docker compose --profile browser up -d
```

and that `BROWSER_URL=http://chromium:3000` must be set in `.env`. New MCP servers
connect at session start, so it becomes available in a **new conversation**.

## Handing a challenge to the user

1. Say precisely what is on screen and what to click.
2. Point them at **Settings → Browser** in Jarvis. It's the same live session you're
   driving, behind their normal login — no extra password.
3. **Wait.** Do not retry, reload or navigate away; you would destroy the challenge
   they're solving.
4. When they say it's done, carry on from the same tab. Cookies and session are intact.

The profile persists in `agent/data/browser-profile/`, so a cleared challenge usually
holds for days and the profile keeps getting more credible with age.

## Gotchas

- **Screenshots** land in the shared uploads dir. Reference them as
  `/jarvis/agent/workspace/uploads/<filename>`, not `/uploads/<filename>`.
- **One browser, one window.** The user sees exactly what you do. Don't leave a page
  half-filled or a modal open when you hand over; leave it on the step they need.
- **Log out of nothing.** The persistent profile's logged-in state is the asset. Never
  clear cookies or the profile without being asked.
