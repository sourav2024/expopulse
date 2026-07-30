import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Write a file atomically: write to a sibling temp file, then rename over it.
 *
 * `rename` within the same directory is atomic on POSIX and Windows, so a
 * reader sees either the old contents or the new ones — never a half-written
 * file. A bare `writeFile` truncates first, so a crash, SIGINT, or ENOSPC
 * partway through leaves the user with a corrupted source file, config, or
 * image. Fixers edit real project files, so that outcome is unacceptable even
 * though it is rare.
 *
 * The temp file is created alongside the target rather than in the OS temp dir,
 * because `rename` cannot cross filesystem boundaries.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  const dir = path.dirname(target)
  const temp = path.join(dir, `.${path.basename(target)}.expopulse-${process.pid}.tmp`)

  try {
    if (typeof data === 'string') await fs.writeFile(temp, data, encoding ?? 'utf8')
    else await fs.writeFile(temp, data)

    // Carry over the original mode so a fix never widens or narrows permissions.
    try {
      const original = await fs.stat(target)
      await fs.chmod(temp, original.mode)
    } catch {
      // Target did not exist, or the platform does not support chmod: the
      // default mode is correct in both cases.
    }

    await fs.rename(temp, target)
  } catch (err) {
    // Never leave the temp file behind on a failed write.
    await fs.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}
