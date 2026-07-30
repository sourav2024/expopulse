import type { AnalysisResult, Category, Finding } from '../shared/types.js'
import { aggregateRecoverableBytes } from './impact.js'
import { findingKey } from './rules-engine.js'

export interface CategoryDelta {
  category: Category
  before: number
  after: number
  delta: number
}

export interface Comparison {
  /** Findings present in `after` but not `before`. */
  added: Finding[]
  /** Findings present in `before` but not `after`. */
  removed: Finding[]
  /** Findings present in both runs. */
  unchanged: Finding[]
  scoreBefore: number
  scoreAfter: number
  /** Positive means the score improved. */
  scoreDelta: number
  categories: CategoryDelta[]
  /** Estimated bytes recoverable, before and after. */
  bytesBefore: number
  bytesAfter: number
}

/**
 * Diff two analysis runs.
 *
 * Used by `expopulse compare` to show progress between a baseline and the
 * current state, and by `fix` to prove what actually changed.
 */
export function compareResults(before: AnalysisResult, after: AnalysisResult): Comparison {
  const beforeMap = new Map(before.findings.map((f) => [findingKey(f), f]))
  const afterMap = new Map(after.findings.map((f) => [findingKey(f), f]))

  const added: Finding[] = []
  const removed: Finding[] = []
  const unchanged: Finding[] = []

  for (const [key, finding] of afterMap) {
    if (beforeMap.has(key)) unchanged.push(finding)
    else added.push(finding)
  }

  for (const [key, finding] of beforeMap) {
    if (!afterMap.has(key)) removed.push(finding)
  }

  const beforeScores = new Map(before.score.categories.map((c) => [c.category, c.score]))
  const afterScores = new Map(after.score.categories.map((c) => [c.category, c.score]))

  const categories: CategoryDelta[] = []
  for (const category of new Set([...beforeScores.keys(), ...afterScores.keys()])) {
    const b = beforeScores.get(category) ?? 0
    const a = afterScores.get(category) ?? 0
    // Only report categories that actually moved, to keep the diff readable.
    if (b !== a) categories.push({ category, before: b, after: a, delta: a - b })
  }

  return {
    added,
    removed,
    unchanged,
    scoreBefore: before.score.overall,
    scoreAfter: after.score.overall,
    scoreDelta: after.score.overall - before.score.overall,
    categories,
    bytesBefore: totalBytes(before.findings),
    bytesAfter: totalBytes(after.findings),
  }
}

function totalBytes(findings: Finding[]): number {
  // Deduplicated per file, for the same reason the CLI footer is: overlapping
  // rules on one asset describe alternative remedies, not additive savings.
  return aggregateRecoverableBytes(findings)
}
