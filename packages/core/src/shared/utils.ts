import path from 'node:path'

/** Format a byte count for human display, e.g. `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown'
  const abs = Math.abs(bytes)
  if (abs < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // One decimal below 10 for precision, none above to reduce noise.
  const digits = Math.abs(value) < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** Format a millisecond duration for human display. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/** Convert an absolute path to a project-relative POSIX path. */
export function toRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/')
}

/** Truncate a single-line excerpt for display in reports. */
export function truncate(text: string, max = 100): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}

/** Pluralise a noun based on count, e.g. `1 finding` / `2 findings`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** Sum a numeric property across a list, ignoring undefined values. */
export function sumBy<T>(items: T[], pick: (item: T) => number | undefined): number {
  let total = 0
  for (const item of items) total += pick(item) ?? 0
  return total
}

/** Group list items by a derived key. */
export function groupBy<T, K extends string>(items: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const item of items) {
    const k = key(item)
    const bucket = out[k] ?? []
    bucket.push(item)
    out[k] = bucket
  }
  return out
}

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Parse a semver-ish version string into its major number.
 * Tolerates Expo's range prefixes (`~52.0.0`, `^52.0.0`, `52.0.0`).
 */
export function parseMajor(version: string | undefined | null): number | null {
  if (!version) return null
  const match = /(\d+)/.exec(version)
  if (!match?.[1]) return null
  const major = Number.parseInt(match[1], 10)
  return Number.isNaN(major) ? null : major
}
