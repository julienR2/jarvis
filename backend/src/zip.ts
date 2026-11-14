/**
 * Just enough of the zip format to read the text files out of an archive.
 *
 * A WhatsApp "Export chat" shared from iOS (and from Android with media) is a
 * zip holding `_chat.txt` beside the photos. The local model has no tools to
 * unpack it, so the backend does — and pulling in an archive library for one
 * read path would be the larger change. Stored and deflated entries only,
 * which is everything a phone produces; anything else is skipped.
 */
import { inflateRawSync } from 'zlib'
import { basename, extname } from 'path'

export interface ZipText {
  name: string
  text: string
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

export function textEntriesOfZip(
  buf: Buffer,
  opts: { exts: Set<string>; maxBytes: number },
): ZipText[] {
  // The end-of-central-directory record sits in the last 64 KiB + 22 bytes
  // (its comment can run to 65535 bytes), found by scanning back.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  const out: ZipText[] = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('corrupt central directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    // Bit 11: the name is UTF-8; otherwise CP437, which for the ASCII names
    // phones write reads the same as latin1.
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1')
    p += 46 + nameLen + extraLen + commentLen

    const base = basename(name)
    if (name.endsWith('/') || base.startsWith('._') || name.startsWith('__MACOSX/')) continue
    if (!opts.exts.has(extname(base).toLowerCase())) continue
    if (flags & 0x1) continue // encrypted
    if (method !== 0 && method !== 8) continue
    if (total + size > opts.maxBytes) continue

    if (buf.readUInt32LE(local) !== LOCAL_SIG) throw new Error('corrupt local header')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + compressed)
    const data = method === 0 ? raw : inflateRawSync(raw)
    total += data.length
    out.push({ name, text: data.toString('utf8') })
  }
  return out
}
