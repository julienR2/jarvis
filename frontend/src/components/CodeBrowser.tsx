import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  Copy,
  Check,
} from 'lucide-react'
import { api, type CodeEntry, type CodeFile, type Commit } from '../api'
import { useToast } from '../hooks/useToast'
import ContentLayout from './ContentLayout'

type Tab = 'agent' | 'all' | 'changed' | 'commits'

type TreeNode =
  | {
      type: 'file'
      name: string
      path: string
      status: string | null
    }
  | {
      type: 'dir'
      name: string
      path: string
      children: TreeNode[]
      hasChanges: boolean
    }

type DirNode = Extract<TreeNode, { type: 'dir' }>

function buildTree(entries: CodeEntry[]): DirNode {
  const root: DirNode = {
    type: 'dir',
    name: '',
    path: '',
    children: [],
    hasChanges: false,
  }
  for (const { path, status } of entries) {
    const parts = path.split('/')
    let cur: DirNode = root
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const isLast = i === parts.length - 1
      const curPath = parts.slice(0, i + 1).join('/')
      if (isLast) {
        cur.children.push({ type: 'file', name, path: curPath, status })
      } else {
        let next = cur.children.find(
          (c) => c.type === 'dir' && c.name === name,
        ) as DirNode | undefined
        if (!next) {
          next = {
            type: 'dir',
            name,
            path: curPath,
            children: [],
            hasChanges: false,
          }
          cur.children.push(next)
        }
        cur = next
      }
    }
  }
  function post(n: TreeNode): boolean {
    if (n.type === 'file') return !!n.status
    let has = false
    for (const c of n.children) if (post(c)) has = true
    n.hasChanges = has
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return has
  }
  post(root)
  return root
}

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

export default function CodeBrowser() {
  const params = useParams()
  const splat = (params['*'] || '').replace(/^\/+/, '')

  // State lives here so it survives navigation into a detail view and back.
  const [tab, setTab] = useState<Tab>('agent')
  const [agentEntries, setAgentEntries] = useState<CodeEntry[] | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [entries, setEntries] = useState<CodeEntry[] | null>(null)
  const [commits, setCommits] = useState<Commit[] | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [commitsError, setCommitsError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(new Set())
  const [commitFiles, setCommitFiles] = useState<Record<string, CodeEntry[]>>({})

  useEffect(() => {
    api.getAgentTree().then(setAgentEntries).catch((e) => setAgentError(e.message))
    api.getCodeTree().then(setEntries).catch((e) => setTreeError(e.message))
  }, [])

  useEffect(() => {
    if (tab === 'commits' && !commits && !commitsError) {
      api.getCommits().then(setCommits).catch((e) => setCommitsError(e.message))
    }
  }, [tab, commits, commitsError])

  // Detail routes: /code/commit/<hash>/<filepath> or /code/<filepath>
  const commitFileMatch = splat.match(/^commit\/([a-f0-9]{4,40})\/(.+)$/)
  if (commitFileMatch) {
    return <CommitFileView hash={commitFileMatch[1]} path={commitFileMatch[2]} />
  }
  if (splat) return <FileView path={splat} />

  return (
    <MainView
      tab={tab}
      setTab={setTab}
      agentEntries={agentEntries}
      agentError={agentError}
      entries={entries}
      treeError={treeError}
      commits={commits}
      commitsError={commitsError}
      expanded={expanded}
      setExpanded={setExpanded}
      expandedCommits={expandedCommits}
      setExpandedCommits={setExpandedCommits}
      commitFiles={commitFiles}
      setCommitFiles={setCommitFiles}
    />
  )
}

function MainView({
  tab,
  setTab,
  agentEntries,
  agentError,
  entries,
  treeError,
  commits,
  commitsError,
  expanded,
  setExpanded,
  expandedCommits,
  setExpandedCommits,
  commitFiles,
  setCommitFiles,
}: {
  tab: Tab
  setTab: (t: Tab) => void
  agentEntries: CodeEntry[] | null
  agentError: string | null
  entries: CodeEntry[] | null
  treeError: string | null
  commits: Commit[] | null
  commitsError: string | null
  expanded: Set<string>
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>
  expandedCommits: Set<string>
  setExpandedCommits: React.Dispatch<React.SetStateAction<Set<string>>>
  commitFiles: Record<string, CodeEntry[]>
  setCommitFiles: React.Dispatch<React.SetStateAction<Record<string, CodeEntry[]>>>
}) {
  const changedCount = entries?.filter((e) => e.status).length ?? 0

  return (
    <ContentLayout title='Code'>
      {/* Tab pill */}
      <div className='flex items-center gap-2 mb-4'>
        <div className='inline-flex rounded-lg bg-surface border border-border p-0.5'>
          <TabButton active={tab === 'agent'} onClick={() => setTab('agent')}>
            Agent
          </TabButton>
          <TabButton active={tab === 'all'} onClick={() => setTab('all')}>
            Tracked
          </TabButton>
          <TabButton active={tab === 'changed'} onClick={() => setTab('changed')}>
            Changed
            {changedCount > 0 && <Badge>{changedCount}</Badge>}
          </TabButton>
          <TabButton active={tab === 'commits'} onClick={() => setTab('commits')}>
            Commits
          </TabButton>
        </div>
      </div>

      {tab === 'commits' ? (
        <CommitsList
          commits={commits}
          error={commitsError}
          expandedCommits={expandedCommits}
          setExpandedCommits={setExpandedCommits}
          commitFiles={commitFiles}
          setCommitFiles={setCommitFiles}
        />
      ) : tab === 'agent' ? (
        <FileTree
          entries={agentEntries}
          error={agentError}
          onlyChanged={false}
          expanded={expanded}
          setExpanded={setExpanded}
          basePath='/code/agent'
        />
      ) : (
        <FileTree
          entries={entries}
          error={treeError}
          onlyChanged={tab === 'changed'}
          expanded={expanded}
          setExpanded={setExpanded}
        />
      )}
    </ContentLayout>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs rounded-md transition-colors flex items-center gap-1.5 ${active ? 'bg-surface2 text-text-primary' : 'text-text-muted hover:text-text-primary'}`}
    >
      {children}
    </button>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className='text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent font-medium'>
      {children}
    </span>
  )
}

function FileTree({
  entries,
  error,
  onlyChanged,
  expanded,
  setExpanded,
  basePath = '/code',
}: {
  entries: CodeEntry[] | null
  error: string | null
  onlyChanged: boolean
  expanded: Set<string>
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>
  basePath?: string
}) {
  const navigate = useNavigate()

  const tree = useMemo(() => (entries ? buildTree(entries) : null), [entries])
  const changedCount = entries?.filter((e) => e.status).length ?? 0

  const effectiveExpanded = useMemo(() => {
    if (!onlyChanged || !tree) return expanded
    const s = new Set<string>()
    function walk(n: TreeNode) {
      if (n.type === 'dir') {
        if (n.hasChanges) s.add(n.path)
        n.children.forEach(walk)
      }
    }
    walk(tree)
    return s
  }, [onlyChanged, tree, expanded])

  function toggle(path: string) {
    if (onlyChanged) return // auto-managed in this mode
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <>
      {error && (
        <div className='text-danger text-sm p-3 rounded-lg bg-danger/10 border border-danger/20'>
          {error}
        </div>
      )}

      {!entries && !error && (
        <div className='text-text-muted text-sm'>Loading…</div>
      )}

      {tree && (
        <div className='text-sm font-mono'>
          <TreeChildren
            nodes={tree.children}
            depth={0}
            onlyChanged={onlyChanged}
            expanded={effectiveExpanded}
            onToggle={toggle}
            onOpen={(p) => navigate(`${basePath}/${p}`)}
          />
          {onlyChanged && changedCount === 0 && (
            <div className='text-text-muted text-sm font-sans py-4'>
              No changes — the working tree is clean.
            </div>
          )}
        </div>
      )}
    </>
  )
}

function TreeChildren({
  nodes,
  depth,
  onlyChanged,
  expanded,
  onToggle,
  onOpen,
}: {
  nodes: TreeNode[]
  depth: number
  onlyChanged: boolean
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const visible = onlyChanged
    ? nodes.filter((n) =>
        n.type === 'file' ? !!n.status : n.hasChanges,
      )
    : nodes

  return (
    <>
      {visible.map((n) => (
        <TreeRow
          key={n.path}
          node={n}
          depth={depth}
          onlyChanged={onlyChanged}
          expanded={expanded}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}
    </>
  )
}

function TreeRow({
  node,
  depth,
  onlyChanged,
  expanded,
  onToggle,
  onOpen,
}: {
  node: TreeNode
  depth: number
  onlyChanged: boolean
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const indent = { paddingLeft: `${depth * 14 + 8}px` }
  const isDir = node.type === 'dir'
  const isOpen = isDir && expanded.has(node.path)
  const si = !isDir ? statusInfo(node.status) : null
  const toast = useToast()

  // Long-press / click suppression
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)

  function copyPath() {
    navigator.clipboard
      .writeText(node.path)
      .then(() => toast.success('Path copied'))
      .catch(() => toast.error('Could not copy path'))
  }

  function activate() {
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (isDir) onToggle(node.path)
    else onOpen(node.path)
  }

  function startLongPress() {
    longPressed.current = false
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = setTimeout(() => {
      longPressed.current = true
      copyPath()
    }, 500)
  }

  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  return (
    <>
      <div
        role='button'
        tabIndex={0}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            activate()
          }
        }}
        onTouchStart={startLongPress}
        onTouchEnd={cancelLongPress}
        onTouchMove={cancelLongPress}
        onContextMenu={(e) => {
          if (longPressed.current) e.preventDefault()
        }}
        style={indent}
        className='group w-full flex items-center gap-1.5 py-1 pr-2 rounded hover:bg-surface2 transition-colors text-left cursor-pointer select-none'
      >
        {isDir ? (
          <>
            <ChevronRight
              size={12}
              className={`text-text-muted transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`}
            />
            {isOpen ? (
              <FolderOpen size={14} className='text-text-muted shrink-0' />
            ) : (
              <Folder size={14} className='text-text-muted shrink-0' />
            )}
            <span
              className={`truncate ${node.hasChanges ? 'text-text-primary' : 'text-text-secondary'}`}
            >
              {node.name}
            </span>
            {node.hasChanges && (
              <span className='w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0' />
            )}
          </>
        ) : (
          <>
            <span className='w-3 shrink-0' />
            <FileText size={13} className='text-text-muted shrink-0' />
            <span
              className={`truncate ${si ? si.color : 'text-text-secondary'} ${si?.strike ? 'line-through' : ''}`}
            >
              {node.name}
            </span>
            {si && (
              <span
                className={`ml-auto text-[10px] font-semibold ${si.color} shrink-0`}
              >
                {si.label}
              </span>
            )}
          </>
        )}

        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            copyPath()
          }}
          title='Copy path'
          className={`shrink-0 p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface hidden group-hover:inline-flex ${si ? '' : 'ml-auto'}`}
        >
          <Copy size={12} />
        </button>
      </div>

      {isDir && isOpen && (
        <TreeChildren
          nodes={node.children}
          depth={depth + 1}
          onlyChanged={onlyChanged}
          expanded={expanded}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      )}
    </>
  )
}

// ── Commits list ─────────────────────────────────────────────────────────────

function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime()
  const diff = Date.now() - then
  const m = 60_000, h = 60 * m, d = 24 * h
  if (diff < m) return 'just now'
  if (diff < h) return `${Math.floor(diff / m)}m ago`
  if (diff < d) return `${Math.floor(diff / h)}h ago`
  if (diff < 30 * d) return `${Math.floor(diff / d)}d ago`
  return new Date(iso).toLocaleDateString()
}

function CommitsList({
  commits,
  error,
  expandedCommits,
  setExpandedCommits,
  commitFiles,
  setCommitFiles,
}: {
  commits: Commit[] | null
  error: string | null
  expandedCommits: Set<string>
  setExpandedCommits: React.Dispatch<React.SetStateAction<Set<string>>>
  commitFiles: Record<string, CodeEntry[]>
  setCommitFiles: React.Dispatch<React.SetStateAction<Record<string, CodeEntry[]>>>
}) {
  if (error) {
    return (
      <div className='text-danger text-sm p-3 rounded-lg bg-danger/10 border border-danger/20'>
        {error}
      </div>
    )
  }
  if (!commits) return <div className='text-text-muted text-sm'>Loading…</div>
  if (commits.length === 0) {
    return <div className='text-text-muted text-sm'>No commits yet.</div>
  }
  return (
    <div className='flex flex-col'>
      {commits.map((c) => (
        <CommitRow
          key={c.hash}
          commit={c}
          isExpanded={expandedCommits.has(c.hash)}
          files={commitFiles[c.hash]}
          setExpandedCommits={setExpandedCommits}
          setCommitFiles={setCommitFiles}
        />
      ))}
    </div>
  )
}

function CommitRow({
  commit,
  isExpanded,
  files,
  setExpandedCommits,
  setCommitFiles,
}: {
  commit: Commit
  isExpanded: boolean
  files: CodeEntry[] | undefined
  setExpandedCommits: React.Dispatch<React.SetStateAction<Set<string>>>
  setCommitFiles: React.Dispatch<React.SetStateAction<Record<string, CodeEntry[]>>>
}) {
  const navigate = useNavigate()
  const toast = useToast()
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)

  function copy(value: string, label: string) {
    navigator.clipboard
      .writeText(value)
      .then(() => toast.success(`${label} copied`))
      .catch(() => toast.error(`Could not copy ${label.toLowerCase()}`))
  }

  function toggleExpand() {
    setExpandedCommits((prev) => {
      const next = new Set(prev)
      if (next.has(commit.hash)) next.delete(commit.hash)
      else next.add(commit.hash)
      return next
    })
    if (!isExpanded && !files) {
      api
        .getCommit(commit.hash)
        .then((d) =>
          setCommitFiles((prev) => ({ ...prev, [commit.hash]: d.files })),
        )
        .catch(() => toast.error('Could not load commit files'))
    }
  }

  function activate() {
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    toggleExpand()
  }

  function startLongPress() {
    longPressed.current = false
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = setTimeout(() => {
      longPressed.current = true
      copy(commit.hash, 'Hash')
    }, 500)
  }

  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  // Build the tree once files are available, auto-expand all folders for clarity
  const tree = useMemo(() => (files ? buildTree(files) : null), [files])
  const autoExpanded = useMemo(() => {
    const s = new Set<string>()
    if (!tree) return s
    function walk(n: TreeNode) {
      if (n.type === 'dir') {
        s.add(n.path)
        n.children.forEach(walk)
      }
    }
    walk(tree)
    return s
  }, [tree])

  return (
    <>
      <div
        role='button'
        tabIndex={0}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            activate()
          }
        }}
        onTouchStart={startLongPress}
        onTouchEnd={cancelLongPress}
        onTouchMove={cancelLongPress}
        onContextMenu={(e) => {
          if (longPressed.current) e.preventDefault()
        }}
        className='group flex items-center gap-2 py-2 pr-2 pl-1 border-b border-border cursor-pointer select-none hover:bg-surface2 transition-colors'
      >
        <ChevronRight
          size={12}
          className={`text-text-muted transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`}
        />
        <div className='flex-1 min-w-0'>
          <div className='text-sm text-text-primary truncate'>{commit.message}</div>
          <div className='text-[11px] text-text-muted flex items-center gap-2 mt-0.5'>
            <span className='font-mono'>{shortHash(commit.hash)}</span>
            <span>·</span>
            <span className='truncate'>{commit.author}</span>
            <span>·</span>
            <span className='shrink-0'>{relativeDate(commit.date)}</span>
          </div>
        </div>
        <div className='shrink-0 hidden group-hover:flex items-center gap-1'>
          <button
            type='button'
            onClick={(e) => { e.stopPropagation(); copy(commit.hash, 'Hash') }}
            title='Copy hash'
            className='p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface'
          >
            <Copy size={12} />
          </button>
          <button
            type='button'
            onClick={(e) => { e.stopPropagation(); copy(commit.message, 'Message') }}
            title='Copy message'
            className='p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface'
          >
            <FileText size={12} />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className='border-b border-border text-sm font-mono py-1'>
          {!files && <div className='text-text-muted text-sm font-sans px-3 py-2'>Loading…</div>}
          {tree && (
            <TreeChildren
              nodes={tree.children}
              depth={0}
              onlyChanged={false}
              expanded={autoExpanded}
              onToggle={() => { /* auto-expanded, no-op */ }}
              onOpen={(p) => navigate(`/code/commit/${commit.hash}/${p}`)}
            />
          )}
        </div>
      )}
    </>
  )
}

// ── Commit file view (diff of a single file at a specific commit) ───────────

function CommitFileView({ hash, path }: { hash: string; path: string }) {
  const navigate = useNavigate()
  const toast = useToast()
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setDiff(null)
    setError(null)
    api
      .getCommitFile(hash, path)
      .then((r) => setDiff(r.diff))
      .catch((e) => setError(e.message))
  }, [hash, path])

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy path')
    }
  }

  const parts = path.split('/')

  return (
    <ContentLayout
      title={
        <span className='flex items-center min-w-0 text-xs'>
          <button
            onClick={() => navigate('/code')}
            className='shrink-0 text-text-muted hover:text-accent transition-colors'
          >
            Code
          </button>
          <span className='shrink-0 text-text-muted mx-1.5'>/</span>
          <span className='shrink-0 text-text-muted font-mono'>{shortHash(hash)}</span>
          {parts.length > 2 && (
            <>
              <span className='shrink-0 text-text-muted mx-1.5'>/</span>
              <span className='shrink-0 text-text-muted'>…</span>
            </>
          )}
          <span className='shrink-0 text-text-muted mx-1.5'>/</span>
          <span className='text-text-primary font-medium truncate min-w-0 font-mono'>
            {parts[parts.length - 1]}
          </span>
        </span>
      }
    >
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

      {diff === null && !error && (
        <div className='text-text-muted text-sm'>Loading…</div>
      )}

      {diff !== null && (
        <DiffBlock diff={diff} emptyLabel='No changes to this file in this commit.' />
      )}
    </ContentLayout>
  )
}

// ── File view ────────────────────────────────────────────────────────────────

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

  return (
    <ContentLayout
      title={
        <span className='flex items-center min-w-0 text-xs'>
          <button
            onClick={() => navigate('/code')}
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
                onClick={() => navigate(`/code/${parts.slice(0, -2).join('/')}`)}
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
