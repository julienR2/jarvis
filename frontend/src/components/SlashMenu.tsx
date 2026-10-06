import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Terminal } from 'lucide-react'
import { api, type SlashCommand } from '../api'

// One fetch shared by every composer, refreshed after a minute: skills can be
// added at runtime, and the engine's own list is cached about as long.
const TTL_MS = 60_000
let cache: { at: number; list: Promise<SlashCommand[]> } | null = null

function loadCommands(): Promise<SlashCommand[]> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const list = api.getCommands().then(
      (r) => r.commands,
      () => {
        cache = null // let the next `/` try again
        return []
      },
    )
    cache = { at: Date.now(), list }
  }
  return cache.list
}

/** Names that start with what was typed, then names that contain it, then descriptions. */
function rank(commands: SlashCommand[], typed: string): SlashCommand[] {
  const q = typed.toLowerCase()
  if (!q) return commands
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q))
  const inName = commands.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q))
  const inDesc = commands.filter(
    (c) => !starts.includes(c) && !inName.includes(c) && c.description.toLowerCase().includes(q),
  )
  return [...starts, ...inName, ...inDesc]
}

/**
 * The composer's `/` menu: open while the input is a lone `/word` — the
 * command's name still being typed — and closed by a space, Escape, or a pick.
 * A pick writes `/name ` into the input and leaves sending to Send, so a
 * command's arguments go after it the same way whether picked or typed.
 */
export function useSlashMenu(input: string, enabled: boolean, setInput: (v: string) => void) {
  const typed = enabled ? /^\/([^\s/]*)$/.exec(input)?.[1] : undefined
  const [commands, setCommands] = useState<SlashCommand[] | null>(null)
  const [active, setActive] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)

  useEffect(() => {
    if (typed === undefined) return
    let live = true
    loadCommands().then((list) => live && setCommands(list))
    return () => {
      live = false
    }
  }, [typed !== undefined])

  // Grouped as drawn — the instance's skills, then Claude Code's own — so the
  // arrow keys walk the list in the order it reads; best match first in each.
  const items = useMemo(() => {
    if (typed === undefined || !commands) return []
    const ranked = rank(commands, typed)
    return [...ranked.filter((c) => !c.builtin), ...ranked.filter((c) => c.builtin)]
  }, [commands, typed])
  useEffect(() => setActive(0), [typed])
  const open = items.length > 0 && dismissedAt !== input

  function pick(c: SlashCommand) {
    setInput(`/${c.name} `)
  }

  /** The composer's keydown, first: true when the menu took the key. */
  function onKeyDown(e: React.KeyboardEvent): boolean {
    if (!open) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + items.length) % items.length)
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      pick(items[Math.min(active, items.length - 1)])
    } else if (e.key === 'Escape') {
      setDismissedAt(input)
    } else {
      return false
    }
    e.preventDefault()
    return true
  }

  return { open, items, active, setActive, pick, onKeyDown }
}

export function SlashMenu({ items, active, onHover, onPick }: {
  items: SlashCommand[]
  active: number
  onHover: (i: number) => void
  onPick: (c: SlashCommand) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div
      ref={listRef}
      role='listbox'
      data-testid='slash-menu'
      className='absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg animate-fade-in'
    >
      {items.map((c, i) => (
        <Fragment key={`${c.builtin ? 'b' : 's'}:${c.name}`}>
          {/* A heading where the kind changes: what you wrote vs what ships with the CLI. */}
          {(i === 0 || items[i - 1].builtin !== c.builtin) && (
            <div
              data-testid={c.builtin ? 'slash-group-builtin' : 'slash-group-skills'}
              className={`flex items-center gap-1.5 px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide ${i === 0 ? 'pt-1.5' : 'mt-1 border-t border-border pt-2'} ${c.builtin ? 'text-text-muted' : 'text-accent'}`}
            >
              {c.builtin ? <Terminal size={11} /> : <Sparkles size={11} />}
              {c.builtin ? 'Claude Code' : 'Skills'}
            </div>
          )}
          <button
            type='button'
            role='option'
            aria-selected={i === active}
            data-index={i}
            data-kind={c.builtin ? 'builtin' : 'skill'}
            // Not a click: the textarea would blur first and the keyboard drop on mobile.
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(c)
            }}
            onMouseEnter={() => onHover(i)}
            className={`flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left ${i === active ? 'bg-bg' : ''}`}
          >
            <span className={`shrink-0 font-mono text-[13px] ${c.builtin ? 'text-text-secondary' : 'text-accent'}`}>/{c.name}</span>
            {c.argumentHint && <span className='max-w-[40%] shrink-0 truncate font-mono text-[11px] text-text-muted'>{c.argumentHint}</span>}
            <span className='min-w-0 flex-1 truncate text-[12px] text-text-muted'>{c.description}</span>
          </button>
        </Fragment>
      ))}
    </div>
  )
}
