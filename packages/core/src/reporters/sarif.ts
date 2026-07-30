import type { AnalysisResult, Finding, Severity } from '../shared/types.js'
import { clamp } from '../shared/utils.js'
import type { Reporter } from './index.js'

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'
const INFORMATION_URI = 'https://github.com/truxo/expopulse'

/** Base URL for per-rule documentation. Mirrors `RuleMeta.docs` conventions. */
const RULE_DOCS_BASE = 'https://github.com/truxo/expopulse/blob/main/docs/rules'

/**
 * SARIF `level` is a closed set of four values, and `critical` is not one of
 * them. Collapsing critical onto `error` is what GitHub code scanning expects;
 * the original severity is preserved in `properties.severity` so nothing is
 * lost for consumers that care.
 */
const LEVEL_BY_SEVERITY: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  error: 'error',
  warning: 'warning',
  info: 'note',
}

interface SarifReportingDescriptor {
  id: string
  shortDescription: { text: string }
  fullDescription: { text: string }
  helpUri: string
  properties: { category: string }
}

interface SarifResult {
  ruleId: string
  ruleIndex: number
  level: 'error' | 'warning' | 'note'
  message: { text: string }
  locations?: {
    physicalLocation: {
      artifactLocation: { uri: string }
      region: { startLine: number; startColumn?: number }
    }
  }[]
  properties?: Record<string, unknown>
}

/**
 * Windows paths and stray leading slashes both break `artifactLocation.uri`,
 * which must be a relative POSIX path for GitHub to match it to a repo file.
 */
function toSarifUri(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * Build the rule descriptor table from the findings actually present.
 *
 * The registry is not consulted on purpose: a result may be replayed from JSON
 * on a machine where the producing plugin is not installed, and every `result`
 * must still resolve to a descriptor. Insertion order defines `ruleIndex`.
 */
function collectRules(findings: readonly Finding[]): {
  rules: SarifReportingDescriptor[]
  indexById: Map<string, number>
} {
  const rules: SarifReportingDescriptor[] = []
  const indexById = new Map<string, number>()

  for (const finding of findings) {
    if (indexById.has(finding.ruleId)) continue

    indexById.set(finding.ruleId, rules.length)
    rules.push({
      id: finding.ruleId,
      // The first occurrence's message is the best short description available
      // without the rule metadata; rationale fills the long form when present.
      shortDescription: { text: finding.message },
      fullDescription: { text: finding.rationale ?? finding.message },
      helpUri: `${RULE_DOCS_BASE}/${encodeURIComponent(finding.ruleId)}.md`,
      properties: { category: finding.category },
    })
  }

  return { rules, indexById }
}

function toSarifResult(finding: Finding, ruleIndex: number): SarifResult {
  const out: SarifResult = {
    ruleId: finding.ruleId,
    ruleIndex,
    level: LEVEL_BY_SEVERITY[finding.severity],
    message: { text: finding.message },
    properties: { category: finding.category, severity: finding.severity },
  }

  // Project-wide findings genuinely have no location. SARIF allows an empty
  // `locations` omission, and inventing `line 1 of package.json` would put the
  // annotation on an unrelated line in a code-scanning diff.
  if (finding.file) {
    const region: { startLine: number; startColumn?: number } = {
      // Validators reject startLine 0, and rules occasionally report 0 for
      // "whole file" findings.
      startLine: clamp(finding.location?.line ?? 1, 1, Number.MAX_SAFE_INTEGER),
    }
    // SARIF columns are 1-based; `SourceLocation.column` is 0-based (Babel).
    if (finding.location?.column !== undefined) {
      region.startColumn = clamp(finding.location.column + 1, 1, Number.MAX_SAFE_INTEGER)
    }

    out.locations = [
      {
        physicalLocation: {
          artifactLocation: { uri: toSarifUri(finding.file) },
          region,
        },
      },
    ]
  }

  return out
}

/** SARIF 2.1.0 log, consumable by GitHub code scanning. */
export const sarifReporter: Reporter = {
  format: 'sarif',
  extension: 'sarif',
  render(result: AnalysisResult): string {
    const { rules, indexById } = collectRules(result.findings)

    const results: SarifResult[] = result.findings.map((finding) => {
      const index = indexById.get(finding.ruleId)
      // `collectRules` walked the same array, so this is unreachable; the guard
      // exists because `noUncheckedIndexedAccess` cannot prove it.
      if (index === undefined) throw new Error(`missing rule descriptor for ${finding.ruleId}`)
      return toSarifResult(finding, index)
    })

    const log = {
      version: '2.1.0',
      $schema: SARIF_SCHEMA,
      runs: [
        {
          tool: {
            driver: {
              name: 'ExpoPulse',
              informationUri: INFORMATION_URI,
              semanticVersion: result.toolVersion,
              rules,
            },
          },
          // An empty `results` array is valid and is how a clean run is
          // reported — omitting it would read as "no analysis performed".
          results,
          invocations: [
            {
              executionSuccessful: true,
              endTimeUtc: result.timestamp,
            },
          ],
          properties: {
            overallScore: result.score.overall,
            durationMs: result.metrics.durationMs,
          },
        },
      ],
    }

    return `${JSON.stringify(log, null, 2)}\n`
  },
}
