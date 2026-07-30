import type { Finding } from '../shared/types.js'

/**
 * Aggregate estimated recoverable bytes across findings.
 *
 * Naively summing `estimatedImpact.bytes` overstates the total, because
 * several rules legitimately fire on the same file: a large unused image is
 * reported by `unused-asset` (its full size), `oversized-image` (what
 * compression would save) and `prefer-webp` (what conversion would save).
 * Those are alternative remedies for one file, not additive ones — deleting it
 * recovers its bytes exactly once.
 *
 * So we take the maximum plausible saving per file rather than the sum, and add
 * project-level findings (which have no file) separately.
 */
export function aggregateRecoverableBytes(findings: Finding[]): number {
  const perFile = new Map<string, number>()
  let fileless = 0

  for (const finding of findings) {
    const bytes = finding.estimatedImpact?.bytes
    if (!bytes || bytes <= 0) continue

    if (!finding.file) {
      // No file to deduplicate against; assume distinct.
      fileless += bytes
      continue
    }

    // Deleting a file supersedes compressing it, so the largest single
    // estimate for a file is the best available guess at what it can yield.
    perFile.set(finding.file, Math.max(perFile.get(finding.file) ?? 0, bytes))
  }

  let total = fileless
  for (const bytes of perFile.values()) total += bytes
  return total
}

/**
 * Group the per-file maxima, for reporters that want to show the largest
 * contributors rather than a single total.
 */
export function largestContributors(
  findings: Finding[],
  limit = 10,
): { file: string; bytes: number }[] {
  const perFile = new Map<string, number>()

  for (const finding of findings) {
    const bytes = finding.estimatedImpact?.bytes
    if (!bytes || bytes <= 0 || !finding.file) continue
    perFile.set(finding.file, Math.max(perFile.get(finding.file) ?? 0, bytes))
  }

  return [...perFile.entries()]
    .map(([file, bytes]) => ({ file, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
}
