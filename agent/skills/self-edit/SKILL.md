---
name: self-edit
description: Modify Jarvis's own frontend source code. Use ONLY when the user explicitly asks to modify Jarvis itself (e.g. "improve your interface", "work on Jarvis", "change your chat UI", "add a feature to Jarvis"). Do NOT activate from ambiguous requests.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Self-Edit Skill — Modify Jarvis Frontend

You can edit Jarvis's own frontend source code. Changes are picked up instantly by Vite HMR — no restart needed.

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
4. Changes are live immediately — Vite HMR updates the browser without a full reload

## Important guidelines

- **Follow existing patterns** — match the code style, component structure, and naming conventions already in use
- **Small, incremental changes** — make one change at a time so the user can see each update live
- **Don't break things** — if you're unsure about a change, explain what you plan to do and ask before editing
- **No backend changes** — this skill is for frontend only. If the user needs backend changes, explain that those require a different approach
- **Explain what you changed** — after each edit, briefly tell the user what you modified and what they should see
