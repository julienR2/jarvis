import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronRight, Folder, FolderOpen, FileText, Copy, Check, Loader2 } from 'lucide-react'
import { api, type CodeEntry, type CodeFile, type CodeListing, type CodeListingEntry } from '../api'
import { useToast } from '../hooks/useToast'
import ContentLayout from './ContentLayout'

// Dominant status marker: D > ? > A > M > R/C/U
function statusInfo(status: string | null): {
  label: string
  color: string
  strike: boolean
} | null {
  if (!status) return null
  if (status.includes('D')) return { label: 'D', color: 'text-danger', strike: true }
  if (status.includes('?')) return { label: 'U', color: 'text-success', strike: false }
  if (status.includes('A')) return { label: 'A', color: 'text-success', strike: false }
  if (status.includes('M')) return { label: 'M', color: 'text-amber-500', strike: false }
  if (status.includes('R')) return { label: 'R', color: 'text-accent', strike: false }
  const trimmed = status.trim()
  return trimmed
    ? { label: trimmed[0], color: 'text-accent', strike: false }
    : null
}

/** Folders open this session, so coming back from a file finds the tree as left. */
const OPEN_KEY = 'code-open-dirs'
const ONLY_KEY = 'code-changes-only'

function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function writeSession(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private window — the tree just won't be remembered */
  }
}

/**
 * The repo as a tree, one folder at a time.
 *
 * Folders load when opened, so a node_modules is one row until someone opens
 * it. What changed stands out — the file with its status letter, every folder
 * above it with a count — and what git ignores is dimmed rather than hidden,
 * since agent/ (config, workspace, data) is mostly ignored and still worth
 * browsing. "Changes only" swaps the tree for just the changed files.
 */
export default function CodeBrowser() {
  const splat = (useParams()['*'] || '').replace(/^\/+/, '')
  if (splat) return <FileView path={splat} />
  return <TreeView />
}

function TreeView() {
  const [onlyChanges, setOnlyChanges] = useState<boolean>(() => readSession(ONLY_KEY, false))
  const [open, setOpen] = useState<Set<string>>(() => new Set(readSession<string[]>(OPEN_KEY, [])))
  const [listings, setListings] = useState<Record<string, CodeListing | 'loading' | 'error'>>({})
  const [changes, setChanges] = useState<CodeEntry[] | null>(null)

  const load = useCallback((path: string) => {
    setListings((l) => ({ ...l, [path]: l[path] && l[path] !== 'error' ? l[path] : 'loading' }))
    api.listCode(path)
      .then((listing) => setListings((l) => ({ ...l, [path]: listing })))
      .catch(() => setListings((l) => ({ ...l, [path]: 'error' })))
  }, [])

  const reload = useCallback(() => {
    load('')
    for (const p of open) load(p)
    api.getCodeChanges().then(setChanges).catch(() => setChanges([]))
  }, [load, open])

  // First paint: the root, every folder left open, and the change list (its
  // count heads the page whichever view is on).
  useEffect(() => { reload() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => writeSession(OPEN_KEY, [...open]), [open])
  useEffect(() => writeSession(ONLY_KEY, onlyChanges), [onlyChanges])

  function toggle(path: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!listings[path] || listings[path] === 'error') load(path)
      }
      return next
    })
  }

  const changeCount = changes?.length ?? 0

  return (
    <ContentLayout title='Code'>
      <div>
        <div className='flex items-center gap-3 mb-3'>
          <span className='text-xs text-text-muted' data-testid='code-change-count'>
            {changes === null ? '…' : changeCount === 0 ? 'No uncommitted changes' : `${changeCount} changed file${changeCount > 1 ? 's' : ''}`}
          </span>
          <label className='ml-auto flex items-center gap-2 text-xs text-text-secondary cursor-pointer select-none'>
            Changes only
            <button
              role='switch'
              aria-checked={onlyChanges}
              aria-label='Changes only'
              onClick={() => setOnlyChanges((v) => !v)}
              className={`relative h-4 w-7 rounded-full transition-colors ${onlyChanges ? 'bg-accent' : 'bg-border'}`}
            >
              <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${onlyChanges ? 'left-[14px]' : 'left-0.5'}`} />
            </button>
          </label>
        </div>

        <RecoveryActions onDone={reload} hasChanges={changeCount > 0} />

        <div className='mt-3 rounded-xl border border-border bg-surface py-2 pr-2 font-mono text-[13px]' data-testid='code-tree'>
          {onlyChanges && changeCount === 0 && changes !== null ? (
            <div className='px-3 py-2 font-sans text-sm text-text-muted'>Nothing changed since the last commit.</div>
          ) : (
            <Level path='' depth={0} listings={listings} open={open} onToggle={toggle} onlyChanges={onlyChanges} />
          )}
        </div>
      </div>
    </ContentLayout>
  )
}

function Level({ path, depth, listings, open, onToggle, onlyChanges }: {
  path: string
  depth: number
  listings: Record<string, CodeListing | 'loading' | 'error'>
  open: Set<string>
  onToggle: (path: string) => void
  /** Same tree, same folds — only what changed is kept. */
  onlyChanges: boolean
}) {
  const listing = listings[path]
  if (!listing || listing === 'loading') return <Spinner depth={depth} />
  if (listing === 'error') return <div className='py-1 font-sans text-xs text-danger' style={{ paddingLeft: pad(depth) }}>Could not read this folder.</div>
  const entries = onlyChanges
    ? listing.entries.filter((e) => (e.dir ? e.changes > 0 : !!e.status))
    : listing.entries
  return (
    <>
      {entries.map((e) =>
        e.dir ? (
          <div key={e.path}>
            <DirRow entry={e} depth={depth} open={open.has(e.path)} onToggle={() => onToggle(e.path)} />
            {open.has(e.path) && <Level path={e.path} depth={depth + 1} listings={listings} open={open} onToggle={onToggle} onlyChanges={onlyChanges} />}
          </div>
        ) : (
          <FileRow key={e.path} name={e.name} path={e.path} status={e.status} ignored={e.ignored} depth={depth} />
        ),
      )}
      {listing.truncated && (
        <div className='py-1 font-sans text-[11px] text-text-muted italic' style={{ paddingLeft: pad(depth) }}>
          Only the first {listing.entries.length} entries are listed.
        </div>
      )}
      {entries.length === 0 && (
        <div className='py-1 font-sans text-[11px] text-text-muted italic' style={{ paddingLeft: pad(depth) }}>Empty</div>
      )}
    </>
  )
}

const pad = (depth: number) => 30 + depth * 18

function DirRow({ entry, depth, open, onToggle }: { entry: CodeListingEntry; depth: number; open: boolean; onToggle: () => void }) {
  const changed = entry.changes > 0
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-1.5 py-1 pr-3 text-left hover:bg-surface2 transition-colors ${entry.ignored ? 'opacity-45' : ''} ${changed ? 'text-amber-600 dark:text-amber-400' : 'text-text-primary'}`}
      style={{ paddingLeft: pad(depth) - 16 }}
      aria-expanded={open}
    >
      <ChevronRight size={12} className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
      {open ? <FolderOpen size={13} className='shrink-0 text-text-muted' /> : <Folder size={13} className='shrink-0 text-text-muted' />}
      <span className='truncate'>{entry.name}</span>
      {changed && <span className='ml-auto shrink-0 font-sans text-[10px]'>{entry.changes}</span>}
    </button>
  )
}

function FileRow({ name, path, status, ignored, depth }: { name: string; path: string; status: string | null; ignored: boolean; depth: number }) {
  const navigate = useNavigate()
  const info = statusInfo(status)
  return (
    <button
      onClick={() => navigate(`/code/${path}`)}
      className={`w-full flex items-center gap-1.5 py-1 pr-3 text-left hover:bg-surface2 transition-colors ${ignored ? 'opacity-45' : ''} ${info ? info.color : 'text-text-secondary'}`}
      style={{ paddingLeft: pad(depth) }}
    >
      <FileText size={13} className='shrink-0 text-text-muted' />
      <span className={`truncate ${info?.strike ? 'line-through' : ''}`}>{name}</span>
      {info && <span className='ml-auto shrink-0 font-sans text-[10px] font-semibold'>{info.label}</span>}
    </button>
  )
}

function Spinner({ depth }: { depth: number }) {
  return (
    <div className='py-1 text-text-muted' style={{ paddingLeft: pad(depth) }}>
      <Loader2 size={12} className='animate-spin' />
    </div>
  )
}

function FileView({ path }: { path: string }) {
  const navigate = useNavigate()
  const [file, setFile] = useState<CodeFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setFile(null)
    setError(null)
    api
      .getCodeFile(path)
      .then(setFile)
      .catch((e) => setError(e.message))
  }, [path])

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* noop */
    }
  }

  const parts = path.split('/')

  // Back to the tree with the folder holding this file (and its parents) open.
  function revealInTree(dirParts: string[]) {
    const open = new Set(readSession<string[]>(OPEN_KEY, []))
    for (let i = 1; i <= dirParts.length; i++) open.add(dirParts.slice(0, i).join('/'))
    writeSession(OPEN_KEY, [...open])
    navigate('/code')
  }

  return (
    <ContentLayout
      title={
        <span className='flex items-center min-w-0 text-xs'>
          <button
            onClick={() => revealInTree(parts.slice(0, -1))}
            className='shrink-0 text-text-muted hover:text-accent transition-colors'
          >
            Code
          </button>
          {parts.length > 3 && (
            <>
              <span className='shrink-0 text-text-muted mx-1.5'>/</span>
              <span className='shrink-0 text-text-muted'>…</span>
            </>
          )}
          {parts.length > 2 && (
            <>
              <span className='shrink-0 text-text-muted mx-1.5'>/</span>
              <button
                onClick={() => revealInTree(parts.slice(0, -1))}
                className='text-text-muted hover:text-accent transition-colors truncate min-w-0'
              >
                {parts[parts.length - 2]}
              </button>
            </>
          )}
          <span className='shrink-0 text-text-muted mx-1.5'>/</span>
          <span className='text-text-primary font-medium truncate min-w-0 font-mono'>
            {parts[parts.length - 1]}
          </span>
        </span>
      }
    >
      {/* Action row */}
      <div className='flex items-center gap-2 mb-3 text-xs'>
        <span className='text-text-muted font-mono truncate'>{path}</span>
        <button
          onClick={copyPath}
          title='Copy path'
          className='ml-auto shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface2 transition-colors'
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? 'Copied' : 'Copy path'}</span>
        </button>
      </div>

      {error && (
        <div className='text-danger text-sm p-3 rounded-lg bg-danger/10 border border-danger/20'>
          {error}
        </div>
      )}

      {!file && !error && (
        <div className='text-text-muted text-sm'>Loading…</div>
      )}

      {file && <FileBody file={file} />}
    </ContentLayout>
  )
}

function FileBody({ file }: { file: CodeFile }) {
  if (file.tooLarge) {
    return (
      <div className='text-text-muted text-sm p-4 rounded-lg bg-surface border border-border'>
        File is too large to display (&gt; 1 MB).
      </div>
    )
  }
  if (file.binary) {
    return (
      <div className='text-text-muted text-sm p-4 rounded-lg bg-surface border border-border'>
        Binary file — not shown.
      </div>
    )
  }
  if (file.status && file.status.includes('D')) {
    // File deleted — show its diff (deletion)
    return <DiffBlock diff={file.diff || ''} emptyLabel='File deleted.' />
  }
  if (file.diff) {
    return <DiffBlock diff={file.diff} emptyLabel='No changes.' />
  }
  // Untracked (??) or unchanged — just show content
  const lines = (file.content || '').split('\n')
  const isNew = file.status?.includes('?') ?? false
  return (
    <div className='rounded-lg border border-border bg-surface overflow-hidden'>
      <table className='w-full font-mono text-xs'>
        <tbody>
          {lines.map((line, i) => (
            <tr
              key={i}
              className={isNew ? 'bg-success/10' : undefined}
            >
              <td className='select-none text-right pr-3 pl-2 py-0.5 text-text-muted w-10 align-top tabular-nums'>
                {i + 1}
              </td>
              <td className={`pr-3 py-0.5 whitespace-pre-wrap break-all align-top ${isNew ? 'text-success' : 'text-text-primary'}`}>
                {isNew && <span className='select-none'>+ </span>}
                {line}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Unified diff parser + renderer ────────────────────────────────────────────

type DiffLine =
  | { kind: 'header'; text: string }
  | { kind: 'hunk'; text: string }
  | { kind: 'ctx'; text: string; oldNo: number; newNo: number }
  | { kind: 'add'; text: string; newNo: number }
  | { kind: 'del'; text: string; oldNo: number }

function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  const lines = diff.split('\n')
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      out.push({ kind: 'header', text: line })
    } else if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename ') ||
      line.startsWith('copy ') ||
      line.startsWith('Binary files ')
    ) {
      out.push({ kind: 'header', text: line })
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        oldNo = parseInt(m[1], 10)
        newNo = parseInt(m[2], 10)
      }
      out.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), newNo })
      newNo++
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldNo })
      oldNo++
    } else if (line.startsWith(' ')) {
      out.push({ kind: 'ctx', text: line.slice(1), oldNo, newNo })
      oldNo++
      newNo++
    }
    // '\ No newline at end of file' and empty trailing lines: ignore
  }
  return out
}

function DiffBlock({ diff, emptyLabel }: { diff: string; emptyLabel: string }) {
  const parsed = useMemo(() => parseDiff(diff), [diff])
  if (parsed.length === 0) {
    return (
      <div className='text-text-muted text-sm p-4 rounded-lg bg-surface border border-border'>
        {emptyLabel}
      </div>
    )
  }
  return (
    <div className='rounded-lg border border-border bg-surface overflow-hidden'>
      <table className='w-full font-mono text-xs'>
        <tbody>
          {parsed.map((l, i) => {
            if (l.kind === 'header') {
              return (
                <tr key={i}>
                  <td colSpan={3} className='px-3 py-1 text-text-muted bg-surface2/60 text-[11px]'>
                    {l.text}
                  </td>
                </tr>
              )
            }
            if (l.kind === 'hunk') {
              return (
                <tr key={i}>
                  <td colSpan={3} className='px-3 py-1 text-accent bg-accent/5 text-[11px]'>
                    {l.text}
                  </td>
                </tr>
              )
            }
            const bg =
              l.kind === 'add'
                ? 'bg-success/10'
                : l.kind === 'del'
                  ? 'bg-danger/10'
                  : ''
            const fg =
              l.kind === 'add'
                ? 'text-success'
                : l.kind === 'del'
                  ? 'text-danger'
                  : 'text-text-primary'
            const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
            const oldNo = l.kind === 'add' ? '' : l.oldNo
            const newNo = l.kind === 'del' ? '' : l.newNo
            return (
              <tr key={i} className={bg}>
                <td className='select-none text-right pr-2 pl-2 py-0.5 text-text-muted w-10 align-top tabular-nums text-[10px]'>
                  {oldNo}
                </td>
                <td className='select-none text-right pr-2 py-0.5 text-text-muted w-10 align-top tabular-nums text-[10px]'>
                  {newNo}
                </td>
                <td className={`pr-3 py-0.5 whitespace-pre-wrap break-all align-top ${fg}`}>
                  <span className='select-none'>{marker} </span>
                  {l.text}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


/**
 * Commit or throw away what Jarvis changed.
 *
 * This is the guardrail that makes self-editing survivable: when a change
 * breaks the app, the fix has to be reachable from the UI, because the chat
 * that would normally fix it may be exactly what is broken. Discard first;
 * revert the last commit if the tree is already clean and still wrong.
 */
function RecoveryActions({
  onDone,
  hasChanges,
}: {
  onDone: () => void
  hasChanges: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key)
    setError('')
    try {
      await action()
      setMessage('')
      onDone()
    } catch (err: any) {
      setError(err.message || 'Failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className='rounded-xl border border-border bg-surface p-3 mb-4 flex flex-col gap-2'>
      <div className='flex gap-2'>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={hasChanges ? 'Commit message' : 'Nothing to commit'}
          className='flex-1 bg-bg border border-border text-text-primary rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent'
        />
        <button
          onClick={() => run('commit', () => api.commitChanges(message.trim()))}
          disabled={!message.trim() || !hasChanges || busy !== null}
          className='bg-accent text-white text-sm px-3 py-1.5 rounded-lg hover:bg-accent-hover disabled:opacity-60 transition-colors'
        >
          {busy === 'commit' ? 'Committing…' : 'Commit'}
        </button>
      </div>
      <div className='flex gap-3 text-xs'>
        <button
          onClick={() => {
            if (!confirm('Throw away every uncommitted change?\n\nThis cannot be undone.')) return
            run('discard', () => api.discardChanges())
          }}
          disabled={!hasChanges || busy !== null}
          className='text-danger hover:underline disabled:opacity-60'
        >
          {busy === 'discard' ? 'Discarding…' : 'Discard all changes'}
        </button>
        <button
          onClick={() => {
            if (!confirm('Reset to the previous commit?\n\nThe last commit and any uncommitted work are lost.')) return
            run('revert', () => api.revertLastCommit())
          }}
          disabled={busy !== null}
          className='text-danger hover:underline disabled:opacity-60'
        >
          {busy === 'revert' ? 'Reverting…' : 'Revert last commit'}
        </button>
      </div>
      {error && <p className='text-danger text-xs'>{error}</p>}
    </div>
  )
}
