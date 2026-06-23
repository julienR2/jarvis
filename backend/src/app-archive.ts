import { existsSync, mkdirSync, renameSync, rmSync, cpSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'

/**
 * Move an app's files out of the live `apps/` directory into `apps-archive/`
 * instead of permanently deleting them. Used when a conversation is deleted or
 * when an app is explicitly removed, so an app can always be recovered from the
 * file browser if it was removed by mistake.
 *
 * `appPath` is the stored `conversations.app_path` (e.g. "apps/<id>"); when it
 * is absent we fall back to the conversation id as the directory name. No-op if
 * the app directory doesn't exist.
 */
export function archiveAppDir(
  conversationId: string,
  appPath?: string | null,
): void {
  const dirName = appPath ? appPath.replace(/^apps\//, '') : conversationId
  const appDir = join(config.workspaceDir, 'apps', dirName)
  if (!existsSync(appDir)) return

  const archiveRoot = join(config.workspaceDir, 'apps-archive')
  mkdirSync(archiveRoot, { recursive: true })

  // Normally `<id>`; on the rare re-archive collision (same conversation
  // archived twice) suffix the destination so we never clobber an older copy.
  let dest = join(archiveRoot, dirName)
  if (existsSync(dest)) dest = `${dest}-${Date.now()}`

  try {
    renameSync(appDir, dest)
  } catch {
    // renameSync fails across mount boundaries (EXDEV) — fall back to copy+remove.
    cpSync(appDir, dest, { recursive: true })
    rmSync(appDir, { recursive: true, force: true })
  }
}
