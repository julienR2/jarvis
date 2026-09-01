import { timingSafeEqual } from 'crypto'

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
