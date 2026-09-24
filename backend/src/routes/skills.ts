import type { FastifyInstance } from 'fastify'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { config } from '../config.js'

/** Where the CLI reads skills from: one directory per skill, a SKILL.md in each. */
const SKILLS_DIR = join(config.claudeConfigDir, 'skills')
// A skill name is its directory name — never a path.
const NAME = /^[a-z0-9][a-z0-9._-]*$/i

export interface SkillSummary {
  name: string
  description: string
  /** Ships with the repo (whitelisted in .gitignore) rather than added on this instance. */
  builtin: boolean
}

/** The YAML front matter's `name`/`description`, read without a YAML parser: both are one line. */
function frontMatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/i.exec(line)
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/** The skills the repo ships: `!agent/skills/<name>/` lines of the whitelist in .gitignore. */
function builtinNames(): Set<string> {
  try {
    const gi = readFileSync(join(process.env.JARVIS_REPO_DIR || '/jarvis', '.gitignore'), 'utf8')
    return new Set([...gi.matchAll(/^!agent\/skills\/([^/\s]+)\/?$/gm)].map((m) => m[1]))
  } catch {
    return new Set()
  }
}

/**
 * Skills: what Jarvis knows how to do, read and edited as the SKILL.md files
 * the agent loads at runtime — an edit applies from the next message, no
 * deploy. Creating one is left to Jarvis (ask it in a chat).
 */
export async function skillRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  app.get('/', auth, async () => {
    if (!existsSync(SKILLS_DIR)) return []
    const builtin = builtinNames()
    const skills: SkillSummary[] = []
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue
      const file = join(SKILLS_DIR, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      const fm = frontMatter(readFileSync(file, 'utf8'))
      skills.push({
        name: fm.name || entry.name,
        description: fm.description || '',
        builtin: builtin.has(entry.name),
      })
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  })

  app.get<{ Params: { name: string } }>('/:name', auth, async (req, reply) => {
    if (!NAME.test(req.params.name)) return reply.code(400).send({ error: 'Bad skill name' })
    const file = join(SKILLS_DIR, req.params.name, 'SKILL.md')
    if (!existsSync(file)) return reply.code(404).send({ error: 'No such skill' })
    const raw = readFileSync(file, 'utf8')
    return { name: req.params.name, content: raw.replace(/^---\n[\s\S]*?\n---\n*/, ''), raw }
  })

  // PUT /:name — replace a skill's SKILL.md, front matter included.
  app.put<{ Params: { name: string }; Body: { raw?: unknown } }>('/:name', auth, async (req, reply) => {
    if (!NAME.test(req.params.name)) return reply.code(400).send({ error: 'Bad skill name' })
    const file = join(SKILLS_DIR, req.params.name, 'SKILL.md')
    if (!existsSync(file)) return reply.code(404).send({ error: 'No such skill' })
    const raw = req.body?.raw
    if (typeof raw !== 'string' || !raw.trim()) return reply.code(400).send({ error: 'Empty skill' })
    if (raw.length > 200_000) return reply.code(400).send({ error: 'Skill too large' })
    // Without its front matter the CLI no longer knows when to use it.
    if (!/^---\n[\s\S]*?\bdescription:/.test(raw)) {
      return reply.code(400).send({ error: 'Keep the front matter (--- name / description ---) at the top.' })
    }
    writeFileSync(file, raw.endsWith('\n') ? raw : `${raw}\n`)
    return { ok: true }
  })
}
