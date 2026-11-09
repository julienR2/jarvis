import type { FastifyInstance } from 'fastify'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { config } from '../config.js'
import { listCommands } from '../engine.js'
import { hasInternalSecret } from '../security.js'

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

function listSkills(): SkillSummary[] {
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
}

/** Every file under a skill's directory, relative to it. */
function skillFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...skillFiles(full, base))
    else if (entry.isFile()) out.push(relative(base, full))
  }
  return out.sort()
}

/** Without its front matter the CLI no longer knows when to use a skill. */
function frontMatterError(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Empty skill'
  if (raw.length > 200_000) return 'Skill too large'
  if (!/^---\n[\s\S]*?\bdescription:/.test(raw)) {
    return 'Keep the front matter (--- name / description ---) at the top.'
  }
  return null
}

/**
 * Resolve a path inside a skill's directory, or null if it would leave it.
 * Hidden segments are refused too: nothing a skill needs starts with a dot.
 */
function insideSkill(dir: string, rel: string): string | null {
  if (!rel || rel.length > 200) return null
  if (rel.split('/').some((seg) => !seg || seg.startsWith('.'))) return null
  const full = resolve(dir, rel)
  return full.startsWith(dir + sep) ? full : null
}

const MAX_FILE = 1_000_000

/**
 * Skills: what Jarvis knows how to do, read and edited as the SKILL.md files
 * the agent loads at runtime — an edit applies from the next message, no
 * deploy. Creating one is left to Jarvis (ask it in a chat).
 */
export async function skillRoutes(app: FastifyInstance) {
  const auth = { onRequest: [app.authenticate] }

  app.get('/', auth, async () => listSkills())

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
    const invalid = frontMatterError(raw)
    if (invalid || typeof raw !== 'string') return reply.code(400).send({ error: invalid })
    writeFileSync(file, raw.endsWith('\n') ? raw : `${raw}\n`)
    return { ok: true }
  })
}

/**
 * The same skills, for the agent: /internal/skills, behind the internal secret.
 *
 * The engine mounts agent/skills read-only, so this is the only way the agent
 * changes a skill — and the place to say no. It may create, edit and delete the
 * skills of this instance, but not the ones the repo ships (deploy-critical
 * plumbing like `connectors`, `apps`, `cron`): those change through the repo,
 * reviewed. A prompt-injected turn can still write a skill of its own, which
 * then loads in later sessions — the Skills page lists them, marked as not
 * built in.
 */
export async function internalSkillRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (!hasInternalSecret(req)) return reply.code(403).send({ error: 'Forbidden' })
  })

  // Shared refusals for every write: a bad name, or a built-in skill.
  function writable(name: string, reply: any): string | null {
    if (!NAME.test(name)) {
      reply.code(400).send({ error: 'Bad skill name: letters, digits, dot, dash, underscore' })
      return null
    }
    if (builtinNames().has(name)) {
      reply.code(403).send({
        error: `"${name}" ships with Jarvis and is read-only here. It changes through the repo — tell the user what you would change.`,
      })
      return null
    }
    return join(SKILLS_DIR, name)
  }

  app.get('/', async () => listSkills())

  // GET /:name — SKILL.md and the list of files beside it.
  app.get<{ Params: { name: string } }>('/:name', async (req, reply) => {
    if (!NAME.test(req.params.name)) return reply.code(400).send({ error: 'Bad skill name' })
    const dir = join(SKILLS_DIR, req.params.name)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) return reply.code(404).send({ error: 'No such skill' })
    return {
      name: req.params.name,
      builtin: builtinNames().has(req.params.name),
      raw: readFileSync(file, 'utf8'),
      files: skillFiles(dir),
    }
  })

  // PUT /:name — create the skill, or replace its SKILL.md. { raw }
  app.put<{ Params: { name: string }; Body: { raw?: unknown } }>('/:name', async (req, reply) => {
    const dir = writable(req.params.name, reply)
    if (!dir) return
    const raw = req.body?.raw
    const invalid = frontMatterError(raw)
    if (invalid || typeof raw !== 'string') return reply.code(400).send({ error: invalid })
    const created = !existsSync(join(dir, 'SKILL.md'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), raw.endsWith('\n') ? raw : `${raw}\n`)
    console.log(`[skills] agent ${created ? 'created' : 'updated'} ${req.params.name}`)
    return { ok: true, created }
  })

  // DELETE /:name — the whole skill.
  app.delete<{ Params: { name: string } }>('/:name', async (req, reply) => {
    const dir = writable(req.params.name, reply)
    if (!dir) return
    if (!existsSync(dir)) return reply.code(404).send({ error: 'No such skill' })
    rmSync(dir, { recursive: true, force: true })
    console.log(`[skills] agent deleted ${req.params.name}`)
    return { ok: true }
  })

  // GET /:name/files/<path> — one file beside SKILL.md, as text.
  app.get<{ Params: { name: string; '*': string } }>('/:name/files/*', async (req, reply) => {
    if (!NAME.test(req.params.name)) return reply.code(400).send({ error: 'Bad skill name' })
    const full = insideSkill(join(SKILLS_DIR, req.params.name), req.params['*'])
    if (!full) return reply.code(400).send({ error: 'Bad path' })
    if (!existsSync(full) || !statSync(full).isFile()) return reply.code(404).send({ error: 'No such file' })
    reply.type('text/plain; charset=utf-8')
    return readFileSync(full, 'utf8')
  })

  // PUT /:name/files/<path> — write a file beside SKILL.md (a script, a
  // template). { content, encoding?: 'utf8' | 'base64' }. Scripts are run
  // through their interpreter (`bash x.sh`, `node x.mjs`), so no mode bits.
  app.put<{ Params: { name: string; '*': string }; Body: { content?: unknown; encoding?: unknown } }>(
    '/:name/files/*',
    async (req, reply) => {
      const dir = writable(req.params.name, reply)
      if (!dir) return
      if (!existsSync(join(dir, 'SKILL.md'))) {
        return reply.code(404).send({ error: 'Create the skill (PUT its SKILL.md) first' })
      }
      const full = insideSkill(dir, req.params['*'])
      if (!full) return reply.code(400).send({ error: 'Bad path' })
      if (full === join(dir, 'SKILL.md')) return reply.code(400).send({ error: 'Write SKILL.md with PUT /internal/skills/:name' })
      const { content, encoding } = req.body ?? {}
      if (typeof content !== 'string') return reply.code(400).send({ error: 'content (string) is required' })
      const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
      if (data.length > MAX_FILE) return reply.code(400).send({ error: 'File too large' })
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, data)
      console.log(`[skills] agent wrote ${req.params.name}/${req.params['*']}`)
      return { ok: true }
    },
  )

  // DELETE /:name/files/<path>
  app.delete<{ Params: { name: string; '*': string } }>('/:name/files/*', async (req, reply) => {
    const dir = writable(req.params.name, reply)
    if (!dir) return
    const full = insideSkill(dir, req.params['*'])
    if (!full || full === join(dir, 'SKILL.md')) return reply.code(400).send({ error: 'Bad path' })
    if (!existsSync(full)) return reply.code(404).send({ error: 'No such file' })
    rmSync(full, { force: true })
    return { ok: true }
  })
}

/**
 * GET /api/commands — what the composer's `/` menu offers: this instance's
 * skills and the CLI's own commands worth running from a chat, as the engine's
 * CLI reports them. One list for every model: they all run the same CLI.
 */
export async function commandRoutes(app: FastifyInstance) {
  app.get('/api/commands', { onRequest: [app.authenticate] }, async () => ({ commands: await listCommands() }))
}
