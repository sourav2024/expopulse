import type { AnalysisResult, Category, CategoryScore, Finding } from '../shared/types.js'
import { SEVERITY_RANK } from '../shared/types.js'
import { formatBytes, formatDuration, groupBy, pluralize, truncate } from '../shared/utils.js'
import type { Reporter } from './index.js'

/**
 * Escape a value destined for a GFM table cell.
 *
 * A raw `|` in a file path or a source excerpt terminates the cell and shifts
 * every following column, so this is a correctness fix rather than cosmetics.
 * Newlines get the same treatment: a table row must stay on one line.
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Wrap in backticks for inline code, escaping any backticks already present. */
function code(text: string): string {
  return `\`${cell(text).replace(/`/g, 'ˋ')}\``
}

function locationOf(finding: Finding): string {
  if (!finding.file) return '_project_'
  const line = finding.location?.line
  // Lines are 1-based, so a reported 0 means "whole file"; showing `:0` would
  // send the reader to a line that does not exist.
  return code(line === undefined || line < 1 ? finding.file : `${finding.file}:${line}`)
}

function scoreTable(categories: readonly CategoryScore[]): string[] {
  const lines = ['| Category | Score | Findings |', '| --- | --: | --: |']

  for (const category of categories) {
    // A not-applicable layer scores 100 by construction, which reads as a pass
    // the project never earned. Say so instead.
    const score = category.notApplicable ? 'n/a' : `${category.score}`
    const count = category.notApplicable ? '—' : `${category.findingCount}`
    lines.push(`| ${cell(category.category)} | ${score} | ${count} |`)
  }

  return lines
}

function impactOf(finding: Finding): string | null {
  const impact = finding.estimatedImpact
  if (!impact) return null

  const parts: string[] = []
  if (impact.bytes !== undefined) parts.push(`~${formatBytes(impact.bytes)} smaller`)
  if (impact.startupMs !== undefined) {
    parts.push(`~${formatDuration(impact.startupMs)} faster startup`)
  }
  if (parts.length === 0) return null

  // Flagged as an estimate because it comes from static analysis, not a build.
  return `Estimated impact: ${parts.join(', ')}`
}

/**
 * Render one category section: a findings table plus the per-finding details
 * (recommendations, rationale, excerpts) as a bulleted list beneath it.
 *
 * Details live outside the table on purpose — recommendations are full
 * sentences and would make an already-wide table unreadable.
 */
function categorySection(category: Category, findings: readonly Finding[]): string[] {
  const sorted = [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.file ?? '').localeCompare(b.file ?? ''),
  )

  const lines = [
    `## ${category}`,
    '',
    `${pluralize(sorted.length, 'finding')}.`,
    '',
    '| Severity | Rule | Location | Message |',
    '| --- | --- | --- | --- |',
  ]

  for (const finding of sorted) {
    lines.push(
      `| ${finding.severity} | ${code(finding.ruleId)} | ${locationOf(finding)} | ` +
        `${cell(finding.message)} |`,
    )
  }

  const details = sorted
    .map((finding) => {
      const notes: string[] = []
      if (finding.recommendation) notes.push(cell(finding.recommendation))
      if (finding.rationale) notes.push(cell(finding.rationale))
      if (finding.excerpt) notes.push(code(truncate(finding.excerpt)))
      const impact = impactOf(finding)
      if (impact) notes.push(impact)
      if (finding.fixable) notes.push('Auto-fixable with `expopulse fix`.')
      if (notes.length === 0) return null

      const head = `- ${code(finding.ruleId)}${finding.file ? ` — ${code(finding.file)}` : ''}`
      return [head, ...notes.map((note) => `  - ${note}`)].join('\n')
    })
    .filter((entry): entry is string => entry !== null)

  if (details.length > 0) {
    lines.push('', '<details><summary>Recommendations</summary>', '', ...details, '', '</details>')
  }

  return lines
}

function footer(result: AnalysisResult): string[] {
  const { metrics } = result
  return [
    '---',
    '',
    `Analyzed ${pluralize(metrics.filesAnalyzed, 'file')} and ` +
      `${pluralize(metrics.assetsAnalyzed, 'asset')} against ` +
      `${pluralize(metrics.rulesRun, 'rule')} in ${formatDuration(metrics.durationMs)}.`,
    '',
    `ExpoPulse v${result.toolVersion}`,
  ]
}

/** GitHub-flavoured Markdown report, suitable for PR comments and job summaries. */
export const markdownReporter: Reporter = {
  format: 'markdown',
  extension: 'md',
  render(result: AnalysisResult): string {
    const { findings, score } = result

    const lines: string[] = [
      '# ExpoPulse Report',
      '',
      `**Overall score: ${score.overall}/100** — ${pluralize(findings.length, 'finding')} · ` +
        `${result.timestamp}`,
      '',
      ...scoreTable(score.categories),
      '',
    ]

    if (result.warnings.length > 0) {
      lines.push('> [!WARNING]', ...result.warnings.map((warning) => `> ${cell(warning)}`), '')
    }

    if (findings.length === 0) {
      lines.push('No findings. Every enabled rule passed.', '')
    } else {
      const byCategory = groupBy(findings, (finding) => finding.category)
      // Iterate the score list so section order matches the table above, and
      // so categories with no findings are skipped rather than emitting an
      // empty table.
      for (const category of score.categories) {
        const group = byCategory[category.category]
        if (!group || group.length === 0) continue
        lines.push(...categorySection(category.category, group), '')
      }
    }

    lines.push(...footer(result))

    return `${lines.join('\n')}\n`
  },
}
