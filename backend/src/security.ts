import { timingSafeEqual } from 'crypto'
import { config } from './config.js'

// Constant-time string comparison for shared secrets and setup codes.
export function secureEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    // Still burn a comparison so timing doesn't reveal the length match.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

/** Whether a request carries the backend's internal secret — the agent's credential. */
export function hasInternalSecret(req: { headers: Record<string, unknown> }): boolean {
  const auth = req.headers['x-internal-secret']
  return typeof auth === 'string' && secureEquals(auth, config.internalSecret)
}
