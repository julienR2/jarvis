import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, cpSync, statSync } from 'fs'
import { extname, join } from 'path'
import { config } from './config.js'

/**
 * Move an app's files out of the live `apps/` directory into `apps-archive/`
 * instead of permanently deleting them. Used when a conversation is deleted or
 * when an app is explicitly removed, so an app can always be recovered from the
 * file browser if it was removed by mistake. Uploads get the same treatment
 * (`uploads/<id>` → `uploads-archive/<id>`) when their conversation goes.
 *
 * `appPath` is the stored `conversations.app_path` (e.g. "apps/<id>"); when it
 * is absent we fall back to the conversation id as the directory name. No-op if
 * the app directory doesn't exist.
 */
export function archiveAppDir(
  conversationId: string,
  appPath?: string | null,
): void {
  archiveDir('apps', appDirName(conversationId, appPath))
}

/** The conversation's own upload folder (`uploads/<id>`) → `uploads-archive/`. */
export function archiveUploadsDir(conversationId: string): void {
  archiveDir('uploads', conversationId)
}

/** The other choice on delete: the files go for good. */
export function purgeConversationFiles(conversationId: string, appPath?: string | null): void {
  rmSync(join(config.workspaceDir, 'apps', appDirName(conversationId, appPath)), { recursive: true, force: true })
  rmSync(join(config.workspaceDir, 'uploads', conversationId), { recursive: true, force: true })
}

/**
 * What deleting a chat would take with it on disk: how many uploaded files,
 * and whether it has an app. The delete dialog only asks about what exists.
 */
export function conversationFiles(conversationId: string, appPath?: string | null): { uploads: number; app: boolean } {
  const count = (dir: string): number => {
    if (!existsSync(dir)) return 0
    return readdirSync(dir, { withFileTypes: true }).reduce(
      (n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1),
      0,
    )
  }
  return {
    uploads: count(join(config.workspaceDir, 'uploads', conversationId)),
    app: existsSync(join(config.workspaceDir, 'apps', appDirName(conversationId, appPath))),
  }
}

/**
 * Whether the app listens for what is shared to it from other apps: its code
 * mentions the `jarvis:share-intent` message (agent/skills/apps). One that
 * doesn't would open and do nothing with the share, so the share goes to the
 * chat's composer instead. Read from disk each time — the agent rewrites apps
 * at will, and this is asked once per share.
 */
export function appAcceptsShares(conversationId: string, appPath?: string | null): boolean {
  const CODE = new Set(['.html', '.htm', '.js', '.mjs', '.jsx', '.ts', '.tsx'])
  const MAX_BYTES = 2 * 1024 * 1024
  const search = (dir: string): boolean => {
    if (!existsSync(dir)) return false
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.') && search(path)) return true
      } else if (e.isFile() && CODE.has(extname(e.name).toLowerCase()) && statSync(path).size <= MAX_BYTES) {
        // isFile() is false for a symlink: never follow one the agent planted.
        if (readFileSync(path, 'utf8').includes('jarvis:share-intent')) return true
      }
    }
    return false
  }
  return search(join(config.workspaceDir, 'apps', appDirName(conversationId, appPath)))
}

function appDirName(conversationId: string, appPath?: string | null): string {
  return appPath ? appPath.replace(/^apps\//, '') : conversationId
}

/** `<kind>/<dirName>` → `<kind>-archive/<dirName>`; no-op when there is nothing there. */
function archiveDir(kind: 'apps' | 'uploads', dirName: string): void {
  const dir = join(config.workspaceDir, kind, dirName)
  if (!existsSync(dir)) return

  const archiveRoot = join(config.workspaceDir, `${kind}-archive`)
  mkdirSync(archiveRoot, { recursive: true })

  // Normally `<id>`; on the rare re-archive collision (same conversation
  // archived twice) suffix the destination so we never clobber an older copy.
  let dest = join(archiveRoot, dirName)
  if (existsSync(dest)) dest = `${dest}-${Date.now()}`

  try {
    renameSync(dir, dest)
  } catch {
    // renameSync fails across mount boundaries (EXDEV) — fall back to copy+remove.
    cpSync(dir, dest, { recursive: true })
    rmSync(dir, { recursive: true, force: true })
  }
}
