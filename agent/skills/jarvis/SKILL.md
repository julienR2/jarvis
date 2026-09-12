---
name: self-edit
description: Modify Jarvis's own frontend source code. Use ONLY when the user explicitly asks to modify Jarvis itself (e.g. "improve your interface", "work on Jarvis", "change your chat UI", "add a feature to Jarvis"). Do NOT activate from ambiguous requests.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Self-Edit Skill — Modify Jarvis Frontend

You can edit Jarvis's own frontend source code. **Nothing you save is live**: prod runs without file watchers. Once the user has seen and approved the change, run the `deploy` skill — it builds the frontend and the open tab gets a reload banner. See "Telling the user to reload" below.

## When to use this skill

**ONLY** when the user explicitly asks to modify Jarvis itself. Look for clear intent like:
- "Let's improve your interface"
- "Let's work on Jarvis"
- "Change your chat UI"
- "Add a feature to Jarvis"

**DO NOT** activate this skill if the user is talking about something else that happens to mention UI, files, or code. When in doubt, ask: "Do you want me to modify Jarvis's own interface?"

## Frontend source location

The source is mounted at `/jarvis/frontend/` inside the container.

```
/jarvis/frontend/
├── src/
│   ├── components/    # React components (ChatView, ChatInput, Sidebar, etc.)
│   ├── pages/         # Page components (ChatPage, LoginPage, etc.)
│   ├── api.ts         # API client and SSE connection
│   ├── App.tsx        # Router and layout
│   └── main.tsx       # Entry point
├── index.html
├── tailwind.config.js
└── vite.config.ts
```

**Tech stack**: React 19, TypeScript, Tailwind CSS 4, React Router v7, Lucide icons, react-markdown.

## How to make changes

1. Use `Glob` and `Grep` to explore the codebase and understand existing patterns
2. Read the relevant files before editing — understand the existing code first
3. Use `Edit` for targeted changes, `Write` only for new files
4. Typecheck (`npm --prefix /jarvis/frontend run typecheck`), show the user the diff, and when they approve, run the `deploy` skill

## Telling the user to reload

There is **no hot reload**, and no build until you deploy. The container serves
a fixed production build behind `vite preview`; the `deploy` skill replaces it.
Until the tab reloads after that, the user is looking at the old interface and
your change appears to have done nothing.

When the deploy lands, a **"Jarvis updated its interface" banner with a Reload
button** appears at the bottom of their screen automatically. So:

- **Finish by telling them to reload**, e.g. "Reload to see it — use the Reload
  button in the banner at the bottom, or the ↻ button at the bottom of the sidebar."
- The banner appears once the deploy has swapped the build in; there is nothing
  to wait for after the script returns.
- If they say the change isn't showing, the first question is always whether
  they reloaded.

## Important guidelines

- **Follow existing patterns** — match the code style, component structure, and naming conventions already in use
- **Small, incremental changes** — make one change at a time so the user can review each one after a reload
- **Don't break things** — if you're unsure about a change, explain what you plan to do and ask before editing
- **No backend changes** — this skill is for frontend only. If the user needs backend changes, explain that those require a different approach
- **Explain what you changed** — after each edit, briefly tell the user what you modified, what they should see, and that they need to reload
