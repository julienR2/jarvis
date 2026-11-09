import { realpathSync } from 'fs'
import { sep } from 'path'

/**
 * The real path of `path`, if it exists and still lies inside `root` once
 * every symlink is resolved — otherwise null.
 *
 * Checking the joined path as text is not enough wherever the agent can write.
 * The engine and the backend mount the same tree, but the engine has
 * `agent/data` hidden: a symlink the agent plants in its workspace pointing at
 * `/jarvis/agent/data/secrets.json` dangles in its own container and resolves
 * to the real file in the backend's. Any route serving files from the
 * workspace (apps, uploads) has to resolve before it reads.
 */
export function resolveInside(root: string, path: string): string | null {
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(path)
    return real === realRoot || real.startsWith(realRoot + sep) ? real : null
  } catch {
    return null
  }
}
