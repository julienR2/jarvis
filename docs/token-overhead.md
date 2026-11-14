# The fixed token overhead of a conversation

Every new engine session opens with roughly **30k input tokens** before the
person has typed anything: about 31–49k on the first API call of recent sessions,
median ~32k, nearly all of it cache writes or cache reads. This document breaks
that figure down, explains the oddities, and ranks what could be cut.

Measured 2026-11-14 on the main instance (agent-sdk 0.3.295 / CLI 2.1.295,
`claude-opus-5-5`, 27 instance skills).

## How it was measured

Not estimated from byte counts. The method:

1. **Capture the real request.** A small HTTP proxy inside the engine container
   recorded the body of the first `/v1/messages` call. The probe calls `query()`
   with exactly the options `engine/src/sessions.ts` uses (preset system prompt,
   `settingSources` unset, the same `allowedTools`, `/jarvis/agent/mcp.json`)
   and the prompt "Reply with the single word: ok".
2. **Check that it matches prod.** Forwarded to Anthropic, that request billed
   30,346 input tokens (2 uncached and 30,344 written to cache), which matches
   what the session logs show.
3. **Ablate.** Each piece was removed from the captured request in turn, and the
   rest was counted with `/v1/messages/count_tokens`. A piece's cost is the
   difference between the two counts.
4. **Variants.** To test a config change (dropping an MCP server, `disallowedTools`,
   an env flag), the probe was re-run with that change against a proxy that only
   records the request and doesn't forward it, and the recorded request was counted.

One trap worth knowing: **pointing `ANTHROPIC_BASE_URL` anywhere but Anthropic
turns off tool search** (deferred tool loading). Through a plain proxy the same
session cost 60,520 tokens, because all 80 tool schemas were sent inline. The
measurements below force `ENABLE_TOOL_SEARCH=true` to reproduce prod's direct
route. The gateway route really does run without it (see below).

## Breakdown (Anthropic route, first call: 30,298 tokens)

| Piece | Tokens | Notes |
|---|---:|---|
| **Built-in tool schemas sent in full** | **13,295** | 15 tools + ToolSearch |
| ↳ Workflow | 1,979 | multi-agent orchestration, opt-in only |
| ↳ ScheduleWakeup | 1,695 | `/loop` self-pacing |
| ↳ AskUserQuestion | 1,464 | used by Jarvis (question cards) |
| ↳ Grep | 1,276 | |
| ↳ Agent | 1,209 | subagents |
| ↳ Bash | 1,063 | |
| ↳ ReportFindings | 821 | code-review UI only |
| ↳ Skill / Read / ToolSearch | 623 / 608 / 535 | |
| ↳ ShareOnboardingGuide | 470 | Claude Code onboarding feature |
| ↳ ListAgents | 405 | |
| ↳ Edit / Glob / Write | 348 / 277 / 236 | |
| **`agent/CLAUDE.md`** | **5,721** | |
| ↳ File output (images, PDFs…) | 1,476 | carries a long worked example |
| ↳ Other chats, and Jarvis's own API | 1,101 | |
| ↳ Reading back this conversation | 1,042 | |
| ↳ Where you run | 487 | |
| ↳ Connectors | 356 | |
| ↳ Workspace layout | 312 | |
| ↳ seven other sections | 1,047 | 117–184 each |
| **Skill listing** | **5,454** | 46 skills |
| ↳ 27 instance skills | 3,217 | |
| ↳ 19 skills bundled with the CLI | 2,237 | dataviz, code-review, loop, init… |
| Claude Code preset system prompt | 1,876 | |
| `agent/rules/*.md` | 1,228 | safety 632, emails 498, formatting 98 |
| Deferred tool names (ToolSearch list) | 937 | 16 built-ins + 50 MCP names |
| ↳ `mcp__browser__*` (25 names) | 360 | |
| ↳ `mcp__playwright__*` (25 names) | 385 | |
| Agent types list | 563 | includes `statusline-setup` |
| Environment block | 287 | |
| `CLAUDE.local.md` | 225 | |
| Attribution reminder | 209 | |
| Auto-memory `MEMORY.md` | 153 | |
| Auto-mode note | 165 | |

The pieces add up to within ~200 tokens of the total; the rest is message framing.

### On the gateway route it is twice that

On a gateway turn, `providerEnv` sets `ANTHROPIC_BASE_URL`, so the CLI turns
tool search off and **sends every MCP tool schema inline, every turn**:

| Gateway variant | Tokens |
|---|---:|
| As today (80 tools inline) | 60,994 |
| Without `browser` MCP | 54,309 |
| Without either browser MCP | 47,599 |
| Without `browser`, without unused harness tools, workflows off | 31,519 |
| …and bundled skills off | 29,456 |

## Questions asked

**Are schemas of MCP servers missing from `allowedTools` still sent?** Yes.
`allowedTools` controls auto-approval, not what the model sees. `mcp__browser__*`
is not in the list, yet all 25 of its tools are offered. On the Anthropic route
only their names go out (360 tokens); on the gateway route the full schemas do
(~6.7k). The one thing that list does change is that a `mcp__browser__*` call is
not pre-approved, so it goes to `canUseTool` and the permission rules. To keep
the model from seeing a tool, use `disallowedTools` or leave the server out of
`--mcp-config`.

**Do `playwright` and `browser` duplicate each other?** As tool surfaces, yes:
the same 25 tools under two prefixes. As capabilities, no. `playwright` is
headless and `--isolated`, with a fresh profile on every session. `browser`
attaches over CDP to the headful Chromium with its persistent, logged-in profile,
which is the one that gets past captchas and logins (the `browser` skill
explains when to switch). So removing either one loses something.

**Duplicate config found.** `browser` is declared twice: in `agent/mcp.json`
(passed with `--mcp-config` on every spawn) and again in the CLI's user config
`agent/.claude.json` (`mcpServers.browser`, same URL, left behind by a
`claude mcp add`; there is a `.claude.json.bak-browser` next to it). The CLI
merges them by name, so this costs no tokens. It does mean that removing
`browser` from `mcp.json` alone changes nothing, which hid the server from the
first ablation attempt. `.claude.json` is runtime state outside git, so this
document reports it and leaves the file alone. Removing the entry (`claude mcp
remove browser -s user` with `CLAUDE_CONFIG_DIR=/jarvis/agent`) loses nothing.

**`settingSources`.** Unset loads user, project and local sources. Jarvis's
CLAUDE.md, rules, skills and settings all come from the *user* source
(`CLAUDE_CONFIG_DIR=/jarvis/agent`), and the workspace has no project-level
`.claude/` or CLAUDE.md. So narrowing `settingSources` saves nothing today, and
`[]` would drop CLAUDE.md, rules and skills together.

**No pure-duplication cuts in the repo.** Nothing in the repo is loaded twice:
CLAUDE.md is read once (as the user's global instructions, not again as a parent
directory of the workspace), and every rule file is distinct. The only
duplication is the runtime `.claude.json` entry above. So this change makes no
code cuts. Everything below gives up something, and is listed for a decision.

## Proposed cuts, ranked

Savings are per new session on the Anthropic route unless marked *gw* (gateway).
Each new session, and each isolated cron or webhook run, *writes* this prefix to
cache at 2× the input price (1 h TTL). Later turns *read* it at 0.1×. So the
overhead is mostly a per-spawn cost, plus context-window headroom.

| # | Cut | Saves | What is lost |
|---|---|---:|---|
| 1 | **Gateway route: leave the browser MCP servers out of `--mcp-config`** (or only `browser`) | *gw* 13.4k (6.7k for `browser` only) | Browser automation on gateway models. They are also the models least likely to drive 25 Playwright tools well |
| 2 | **`disallowedTools` for harness tools Jarvis never uses**: ScheduleWakeup, ReportFindings, ShareOnboardingGuide, Workflow, ListAgents, SendMessage, Cron*, Enter/ExitPlanMode, Enter/ExitWorktree, RemoteTrigger, DesignSync, PushNotification, NotebookEdit | 5.5k; *gw* 22.8k (measured together with `CLAUDE_CODE_DISABLE_WORKFLOWS`, on top of #1) | `/loop` pacing, plan mode, worktrees, the CLI's own in-session crons (Jarvis has routines), Workflow orchestration. Keep `Monitor`/`TaskStop`: watching a background process is real agent work |
| 3 | **`CLAUDE_CODE_DISABLE_WORKFLOWS=1` + `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`** | 4.1k | dataviz, claude-api, code-review, security-review, simplify, run, loop/schedule. dataviz is arguably useful to Jarvis. **Never set BUNDLED_SKILLS without WORKFLOWS**: it costs **+4.1k**, because the Workflow tool then inlines its whole authoring reference (its description grows from 5k to 22k characters) |
| 4 | **Move three long CLAUDE.md sections into skills**: "File output" (1,476), "Other chats, and Jarvis's own API" (1,101), "Reading back this conversation" (1,042) | ~3.0k, less ~150 for three skill descriptions | Nothing in principle, but a skill is loaded on the model's judgement. "Reading back this conversation" fires on vague cues ("what did I say earlier"), which is exactly where a skill may not get loaded |
| 5 | **Tighten instance skill descriptions.** The 27 come to 3.2k; the five longest run 450–550 characters | ~1k | Some triggering precision, if overdone |
| 6 | **Drop `browser` on the Anthropic route too** | 0.36k | The headful, logged-in browser. Not worth it |
| 7 | **A lean profile for simple chats**: custom system prompt, `tools: [Read, Bash, Skill]`, no MCP, rules only | the measured floor is preset 1.9k + core tools ~3.3k + CLAUDE.md 5.7k + rules 1.2k ≈ 12k, down to ~5k with a trimmed CLAUDE.md | Everything not in the profile. It needs a per-conversation "mode" and a way to escalate mid-conversation, so a separate feature rather than a cut |

All of #1–#3 combined on the Anthropic route measured **22,749** (from 30,727 in
the same run): −26%. On the gateway: **29,456** (from 60,994): −52%.

The local provider (Part 2 of this branch) sidesteps all of this for private
analysis: it sends no agent prompt at all, only the conversation itself.

## Reproducing

Run `count_tokens` with the instance's OAuth token (it takes
`anthropic-beta: oauth-2025-04-20`). The request to count is whatever the CLI
sends to a recording proxy at `ANTHROPIC_BASE_URL`, with `ENABLE_TOOL_SEARCH=true`
to reproduce the direct route, `persistSession: false` so nothing lands in
`agent/projects`, and `strictMcpConfig: true` when testing MCP changes (see the
`.claude.json` duplicate above).
