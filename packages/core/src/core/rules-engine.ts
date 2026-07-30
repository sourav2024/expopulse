import type {
  Finding,
  ResolvedConfig,
  Rule,
  RuleContext,
  RuleLevel,
  Severity,
} from '../shared/types.js'
import { SEVERITY_RANK } from '../shared/types.js'

/** Resolve a rule's effective level, honouring config overrides. */
export function effectiveLevel(rule: Rule<never>, config: ResolvedConfig): RuleLevel {
  return config.rules[rule.meta.id] ?? rule.meta.severity
}

export function isEnabled(rule: Rule<never>, config: ResolvedConfig): boolean {
  return effectiveLevel(rule, config) !== 'off'
}

export interface RunRulesOutcome {
  findings: Finding[]
  /** Rules that threw, with the reason. Surfaced as analysis warnings. */
  errors: { ruleId: string; error: string }[]
  rulesRun: number
}

/**
 * Execute a set of rules against a collected model.
 *
 * A rule that throws must not abort the analysis: a single bad rule (often on
 * one unusual file) would otherwise cost the user every other finding. Failures
 * are captured and reported as warnings instead.
 */
export async function runRules<TInput>(
  rules: Rule<TInput>[],
  input: TInput,
  ctx: RuleContext,
): Promise<RunRulesOutcome> {
  const findings: Finding[] = []
  const errors: { ruleId: string; error: string }[] = []
  let rulesRun = 0

  for (const rule of rules) {
    const level = effectiveLevel(rule as Rule<never>, ctx.config)
    if (level === 'off') continue

    rulesRun += 1

    try {
      const drafts = await rule.check(input, ctx)

      for (const draft of drafts) {
        // Identity comes from the rule's meta so rules can't misattribute
        // findings. Severity precedence: config override > per-occurrence
        // override > rule default.
        const severity: Severity =
          ctx.config.rules[rule.meta.id] !== undefined
            ? (level as Severity)
            : (draft.severity ?? rule.meta.severity)

        findings.push({
          ...draft,
          ruleId: rule.meta.id,
          category: rule.meta.category,
          severity,
          rationale: draft.rationale ?? rule.meta.rationale,
          recommendation: draft.recommendation ?? rule.meta.recommendation,
          fixable: draft.fixable ?? rule.meta.fixable ?? false,
        })
      }
    } catch (err) {
      errors.push({
        ruleId: rule.meta.id,
        error: err instanceof Error ? err.message : String(err),
      })
      ctx.logger.debug(`rule ${rule.meta.id} threw: ${String(err)}`)
    }
  }

  return { findings, errors, rulesRun }
}

/**
 * Sort findings for presentation: severity descending, then category, then
 * file path, then line. Deterministic ordering matters for snapshot tests and
 * for `compare` to produce stable diffs.
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (bySeverity !== 0) return bySeverity

    const byCategory = a.category.localeCompare(b.category)
    if (byCategory !== 0) return byCategory

    const byRule = a.ruleId.localeCompare(b.ruleId)
    if (byRule !== 0) return byRule

    const byFile = (a.file ?? '').localeCompare(b.file ?? '')
    if (byFile !== 0) return byFile

    return (a.location?.line ?? 0) - (b.location?.line ?? 0)
  })
}

/**
 * Stable identity for a finding, used to diff two analysis runs.
 *
 * Deliberately excludes the line number. Any edit to a file shifts the lines
 * below it, and including the line would report every finding underneath as
 * simultaneously "resolved" and "new" — which is exactly what `compare` exists
 * to rule out. The message is included instead, so two distinct findings from
 * one rule in one file stay separate while a line shift does not fool the diff.
 */
export function findingKey(finding: Finding): string {
  return [finding.ruleId, finding.file ?? '-', finding.message].join('::')
}
