import path from 'node:path'

/**
 * Resolve a project-relative path, refusing anything that escapes the root.
 *
 * Fixers delete and overwrite real files, and the paths reach them from places
 * the user does not fully control: rule `data` (which a third-party plugin can
 * populate) and the on-disk backup manifest (which is written into the project
 * and may be committed, edited, or supplied by someone else). Without this
 * check a `../` segment lets a fix write to — or delete — files anywhere the
 * process can reach.
 *
 * Returns the absolute path, or null when the target escapes the root. Callers
 * must treat null as "skip this action", never as "use the raw path".
 */
export function resolveWithinRoot(root: string, relative: string): string | null {
  if (path.isAbsolute(relative)) {
    // An absolute path is only acceptable if it already lives under the root.
    const abs = path.resolve(relative)
    return isInside(root, abs) ? abs : null
  }

  const abs = path.resolve(root, relative)
  return isInside(root, abs) ? abs : null
}

/** True when `target` is the root itself or sits beneath it. */
export function isInside(root: string, target: string): boolean {
  const from = path.resolve(root)
  const to = path.resolve(target)
  if (from === to) return true

  const rel = path.relative(from, to)
  // path.relative returns a leading '..' segment when `to` is outside `from`,
  // and an absolute path when the two are on different Windows drives.
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
