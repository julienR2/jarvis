// The slash commands a chat can run — what the composer's `/` menu offers.
//
// The list is a property of the CLI and its config dir, not of the model: every
// conversation, Anthropic or gateway, runs the same pinned `claude` with the
// same skills, so one list serves them all. It is asked of the CLI itself — a
// throwaway query that initialises and closes without a prompt, so no API call
// and no cost (~200ms) — rather than rebuilt from the skills directory, so it
// also carries the CLI's own commands and stays right across CLI upgrades.

import { query, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import { WORKSPACE_DIR } from './shared.js'
import { CLAUDE_BIN } from './sessions.js'

export interface Command {
  name: string
  description: string
  argumentHint: string
  /** The CLI's own, as opposed to a skill of this instance. */
  builtin: boolean
}

// The CLI's own commands worth offering in a chat. Most of the rest are bound
// to the terminal (color, focus, heapdump), or fight what Jarvis manages
// itself: /model and /effort against the picker, /clear and /rename against the
// conversation's session and title. An allowlist, so a CLI upgrade adds nothing
// here until someone has looked at it. Every skill of the instance is offered.
const BUILTINS = new Set([
  'compact',
  'context',
  'usage',
  'recap',
  'goal',
  'reload-skills',
  'deep-research',
  'code-review',
  'simplify',
  'security-review',
  'verify',
  'debug',
  'dataviz',
  'claude-api',
])

// Skills are added at runtime (a chat can write one), so the list goes stale.
// A minute is short enough for a new skill to show up while you look for it.
const TTL_MS = 60_000
let cached: { at: number; commands: Command[] } | null = null
let inFlight: Promise<Command[]> | null = null

export async function listCommands(): Promise<Command[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.commands
  inFlight ??= probe()
    .then((commands) => {
      cached = { at: Date.now(), commands }
      return commands
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

async function probe(): Promise<Command[]> {
  // Never yields: the CLI initialises, answers the control request, and is
  // closed before it is ever handed a prompt.
  async function* nothing(): AsyncGenerator<never> {
    await new Promise(() => {})
  }
  const q = query({
    prompt: nothing(),
    options: {
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      cwd: WORKSPACE_DIR,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    },
  })
  try {
    return toCommands(await q.supportedCommands())
  } finally {
    q.close()
  }
}

function toCommands(list: SlashCommand[]): Command[] {
  // When a skill shares a name with one of the CLI's own, typing it runs the
  // CLI's: offering the skill under that name would promise the wrong thing.
  const builtinNames = new Set(list.filter((c) => c.builtin).map((c) => c.name))
  const seen = new Set<string>()
  const out: Command[] = []
  for (const c of list) {
    const builtin = !!c.builtin
    if (seen.has(c.name) || c.name.startsWith('_')) continue
    if (!builtin && builtinNames.has(c.name)) continue
    if (builtin && !BUILTINS.has(c.name)) continue
    seen.add(c.name)
    out.push({ name: c.name, description: c.description, argumentHint: c.argumentHint, builtin })
  }
  return out
}
