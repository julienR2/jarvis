import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, type FileEntry } from '../api'
import ContentLayout from './ContentLayout'

export default function FileBrowser() {
  const location = useLocation()
  const navigate = useNavigate()
  const currentPath = location.pathname.replace('/files', '').replace(/^\//, '')

  const [entries, setEntries] = useState<FileEntry[]>([])
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')

  useEffect(() => {
    setFileContent(null)
    if (!currentPath) {
      api.listFiles().then(setEntries)
    } else {
      api
        .listFiles(currentPath)
        .then(setEntries)
        .catch(() => {
          api.readFile(currentPath).then(({ content }) => {
            setFileContent(content)
            setEditContent(content)
          })
        })
    }
  }, [currentPath])

  async function save() {
    setSaving(true)
    setSavedMsg('')
    try {
      await api.writeFile(currentPath, editContent)
      setFileContent(editContent)
      setSavedMsg('Saved!')
      setTimeout(() => setSavedMsg(''), 2000)
    } catch (err: any) {
      setSavedMsg(`Error: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const breadcrumbs = ['Files', ...currentPath.split('/').filter(Boolean)]

  return (
    <ContentLayout
      title={
        <span className='flex items-center min-w-0'>
          {/* Root — always visible */}
          <button
            onClick={() => navigate('/files')}
            className={`shrink-0 transition-colors ${breadcrumbs.length === 1 ? 'text-text-primary' : 'text-text-muted hover:text-accent'}`}
          >
            Files
          </button>
          {breadcrumbs.length > 3 && (
            <>
              <span className='shrink-0 text-text-muted mx-1.5'>/</span>
              <span className='shrink-0 text-text-muted'>…</span>
            </>
          )}
          {/* Parent — always visible (if exists) */}
          {breadcrumbs.length > 2 && (
            <>
              <span className='shrink-0 text-text-muted mx-1.5'>/</span>
              <button
                onClick={() =>
                  navigate(`/files/${breadcrumbs.slice(1, -1).join('/')}`)
                }
                className='text-text-muted hover:text-accent transition-colors truncate min-w-0'
              >
                {breadcrumbs[breadcrumbs.length - 2]}
              </button>
            </>
          )}
          {/* Current — truncates */}
          {breadcrumbs.length > 1 && (
            <>
              <span className='shrink-0 text-text-muted mx-1.5'>/</span>
              <span className='text-text-primary font-medium truncate min-w-0'>
                {breadcrumbs[breadcrumbs.length - 1]}
              </span>
            </>
          )}
        </span>
      }
    >
      {fileContent !== null ? (
        /* File editor */
        <div className='flex flex-col gap-3'>
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={20}
            className='resize-y font-mono text-xs leading-relaxed bg-surface2 border border-border text-text-primary rounded-lg p-3 focus:border-accent'
          />
          <div className='flex gap-3 items-center'>
            <button
              onClick={save}
              disabled={saving}
              className='bg-accent text-white px-4 py-2 rounded-lg font-medium disabled:opacity-70 hover:bg-accent-hover transition-colors'
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {savedMsg && (
              <span
                className={`text-xs ${savedMsg.startsWith('Error') ? 'text-danger' : 'text-success'}`}
              >
                {savedMsg}
              </span>
            )}
          </div>
        </div>
      ) : (
        /* Directory listing */
        <div className='flex flex-col gap-1'>
          {entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => navigate(`/files/${entry.path}`)}
              className='flex items-center gap-3 px-3.5 py-2.5 bg-surface border border-border rounded-lg text-left text-text-primary hover:bg-surface2 transition-colors'
            >
              <span className='text-base'>
                {entry.type === 'dir' ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}
              </span>
              <span className='flex-1 text-sm'>{entry.name}</span>
              {entry.type === 'file' && (
                <span className='text-text-muted text-xs'>
                  {entry.size > 1024
                    ? `${(entry.size / 1024).toFixed(1)} KB`
                    : `${entry.size} B`}
                </span>
              )}
            </button>
          ))}
          {entries.length === 0 && (
            <div className='text-text-muted p-4 text-sm'>Empty directory</div>
          )}
        </div>
      )}
    </ContentLayout>
  )
}
