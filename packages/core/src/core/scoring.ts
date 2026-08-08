import type { Category, CategoryScore, Finding, Score, Severity } from '../shared/types.js'
import { CATEGORIES } from '../shared/types.js'
import { clamp } from '../shared/utils.js'

/**
 * Penalty applied per finding, by severity.
 *
 * These are deliberately non-linear: one critical issue should hurt more than
 * a handful of hints, because a broken bundle identifier is not "ten inline
 * styles" worth of problem.
 */
const PENALTY: Record<Severity, number> = {
  info: 1,
  warning: 4,
  error: 12,
  critical: 25,
}

/**
 * Weight of each category in the overall score.
 *
 * Categories that block shipping (expo config, native platform) outweigh
 * stylistic ones. Weights are relative, not required to sum to anything.
 */
const WEIGHT: Record<Category, number> = {
  code: 1,
  assets: 1,
  dependencies: 1,
  expo: 1.5,
  android: 1.25,
  ios: 1.25,
  bundle: 1,
  performance: 1,
}

/**
 * Largest penalty any single rule may contribute to its category.
 *
 * Square-root damping alone was not enough: 560 info-level findings from one
 * rule still cost ~29 points, and a handful of such rules drove a category to 0
 * regardless of severity. Capping per rule keeps "one rule fires a lot" from
 * reading like "everything is broken", while several distinct rules still
 * accumulate. 15 lets a single error-level rule (12 per finding) exceed one
 * finding's worth but never dominate on its own.
 */
const MAX_PENALTY_PER_RULE = 15

/**
 * Diminishing returns for repeat offences of the same rule.
 *
 * Without this, a project with 300 inline styles scores 0 on code and the
 * number stops conveying information. The first occurrences carry full
 * weight; later ones are damped so the score stays a useful gradient.
 */
function dampedPenalty(count: number, unitPenalty: number): number {
  if (count <= 0) return 0
  // Full price for the first 5, then square-root growth beyond that. The
  // per-rule ceiling is applied by the caller, across all severities at once.
  const full = Math.min(count, 5)
  const extra = Math.max(0, count - 5)
  return unitPenalty * (full + Math.sqrt(extra))
}

const emptySeverityCounts = (): Record<Severity, number> => ({
  info: 0,
  warning: 0,
  error: 0,
  critical: 0,
})

/**
 * Compute overall and per-category scores.
 *
 * `ranCategories` lists categories whose analyzers actually ran. A category
 * that did not run is marked `notApplicable` and excluded from the overall
 * score — a managed-workflow project with no ios/ directory must not be
 * penalised for iOS findings it cannot have.
 */
export function computeScore(findings: Finding[], ranCategories: Set<Category>): Score {
  const categories: CategoryScore[] = CATEGORIES.map((category) => {
    const own = findings.filter((f) => f.category === category)
    const notApplicable = !ranCategories.has(category)

    const bySeverity = emptySeverityCounts()
    for (const finding of own) bySeverity[finding.severity] += 1

    // Group by rule so damping applies per rule, not across the whole
    // category — 50 findings from one noisy rule shouldn't mask a real error
    // from a different one.
    const byRule = new Map<string, Finding[]>()
    for (const finding of own) {
      const list = byRule.get(finding.ruleId)
      if (list) list.push(finding)
      else byRule.set(finding.ruleId, [finding])
    }

    let penalty = 0
    for (const group of byRule.values()) {
      const bucket = emptySeverityCounts()
      for (const finding of group) {
        // Ignore any severity outside the known set rather than creating a stray
        // bucket key. TypeScript blocks this for built-in rules, but an untyped
        // plugin rule can emit anything, and an unknown severity would look up
        // an undefined penalty and turn this score — and `overall` — into NaN.
        if (bucket[finding.severity] === undefined) continue
        bucket[finding.severity] += 1
      }
      // Cap the rule as a whole, not each severity bucket, so a rule emitting a
      // mix of severities cannot quietly charge the cap several times over.
      let rulePenalty = 0
      for (const severity of Object.keys(bucket) as Severity[]) {
        rulePenalty += dampedPenalty(bucket[severity], PENALTY[severity])
      }
      penalty += Math.min(rulePenalty, MAX_PENALTY_PER_RULE)
    }

    return {
      category,
      // A category with no rules run scores 100 but is flagged N/A, so
      // reporters can render "—" instead of a misleading perfect score.
      score: notApplicable ? 100 : Math.round(clamp(100 - penalty, 0, 100)),
      findingCount: own.length,
      bySeverity,
      notApplicable,
    }
  })

  const applicable = categories.filter((c) => !c.notApplicable)

  // No layers ran at all — report 100 rather than dividing by zero.
  if (applicable.length === 0) {
    return { overall: 100, categories }
  }

  let weighted = 0
  let totalWeight = 0
  for (const entry of applicable) {
    const weight = WEIGHT[entry.category]
    weighted += entry.score * weight
    totalWeight += weight
  }

  return {
    overall: Math.round(clamp(weighted / totalWeight, 0, 100)),
    categories,
  }
}

/** Human-readable grade band for a score, used by reporters. */
export function scoreBand(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (score >= 90) return 'excellent'
  if (score >= 75) return 'good'
  if (score >= 50) return 'fair'
  return 'poor'
}
