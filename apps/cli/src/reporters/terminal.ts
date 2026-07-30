import type { AnalysisResult, Category, Finding, Severity } from '@expopulse/core'
import {
  aggregateRecoverableBytes,
  formatBytes,
  formatDuration,
  pluralize,
  scoreBand,
} from '@expopulse/core'
import boxen from 'boxen'
import chalk from 'chalk'
import Table from 'cli-table3'

/** Colour a score by its band. */
function paintScore(score: number): string {
  const band = scoreBand(score)
  const text = String(score).padStart(3)
  if (band === 'excellent') return chalk.green.bold(text)
  if (band === 'good') return chalk.yellow.bold(text)
  if (band === 'fair') return chalk.hex('#ff8c00').bold(text)
  return chalk.red.bold(text)
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: chalk.bgRed.white.bold(' CRIT '),
  error: chalk.red.bold(' ERROR'),
  warning: chalk.yellow.bold('  WARN'),
  info: chalk.blue('  INFO'),
}

const SEVERITY_ORDER: Severity[] = ['critical', 'error', 'warning', 'info']

/** A 20-cell bar rendering a 0-100 score. */
function bar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width)
  const band = scoreBand(score)
  const colour =
    band === 'excellent'
      ? chalk.green
      : band === 'good'
        ? chalk.yellow
        : band === 'fair'
          ? chalk.hex('#ff8c00')
          : chalk.red
  return colour('█'.repeat(filled)) + chalk.gray('░'.repeat(width - filled))
}

/** The headline score box. */
export function renderHeader(result: AnalysisResult): string {
  const { overall } = result.score
  const counts = countBySeverity(result.findings)

  const summary = SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${SEVERITY_LABEL[s].trim()} ${counts[s]}`)
    .join('   ')

  const lines = [
    `${chalk.bold('Health Score')}   ${paintScore(overall)}${chalk.gray('/100')}  ${bar(overall)}`,
    '',
    summary || chalk.green('No issues found'),
  ]

  return boxen(lines.join('\n'), {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: { top: 1, bottom: 0, left: 0, right: 0 },
    borderStyle: 'round',
    borderColor: scoreBand(overall) === 'poor' ? 'red' : 'cyan',
    title: 'ExpoPulse',
    titleAlignment: 'left',
  })
}

/** Per-category score table. */
export function renderCategoryTable(result: AnalysisResult): string {
  const applicable = result.score.categories.filter((c) => !c.notApplicable)
  if (applicable.length === 0) return ''

  const table = new Table({
    head: [chalk.gray('Category'), chalk.gray('Score'), chalk.gray(''), chalk.gray('Findings')],
    style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
    chars: borderChars(),
  })

  for (const entry of applicable) {
    table.push([
      entry.category,
      paintScore(entry.score),
      bar(entry.score, 14),
      entry.findingCount === 0 ? chalk.green('0') : String(entry.findingCount),
    ])
  }

  // Categories that didn't run are listed separately so a managed-workflow
  // project doesn't look like it silently skipped half the analysis.
  const skipped = result.score.categories.filter((c) => c.notApplicable).map((c) => c.category)
  const note = skipped.length > 0 ? chalk.gray(`\n  not applicable: ${skipped.join(', ')}`) : ''

  return `\n${table.toString()}${note}`
}

/** Findings grouped by category, most severe first. */
export function renderFindings(result: AnalysisResult, verbose: boolean): string {
  if (result.findings.length === 0) {
    return `\n${chalk.green('✔')} No findings. Nothing to fix.\n`
  }

  const groups = new Map<Category, Finding[]>()
  for (const finding of result.findings) {
    const list = groups.get(finding.category)
    if (list) list.push(finding)
    else groups.set(finding.category, [finding])
  }

  const out: string[] = []

  for (const [category, findings] of groups) {
    out.push(
      `\n${chalk.bold.underline(category.toUpperCase())} ${chalk.gray(`(${findings.length})`)}`,
    )

    for (const finding of findings) {
      const where = finding.file
        ? chalk.cyan(finding.file) +
          (finding.location ? chalk.gray(`:${finding.location.line}`) : '')
        : chalk.gray('project')

      out.push(`  ${SEVERITY_LABEL[finding.severity]}  ${finding.message}`)
      out.push(`         ${where}  ${chalk.gray(finding.ruleId)}`)

      if (finding.estimatedImpact?.bytes) {
        out.push(
          `         ${chalk.green(`~${formatBytes(finding.estimatedImpact.bytes)} recoverable`)}`,
        )
      }

      if (finding.fixable) {
        out.push(`         ${chalk.magenta('✚ auto-fixable')}`)
      }

      // Rationale and recommendation are the valuable part but too long for
      // the default view, so they're gated behind --verbose.
      if (verbose) {
        if (finding.rationale) out.push(`         ${chalk.gray(finding.rationale)}`)
        if (finding.recommendation)
          out.push(`         ${chalk.white('→')} ${finding.recommendation}`)
        if (finding.excerpt) out.push(`         ${chalk.gray(`| ${finding.excerpt}`)}`)
      }

      out.push('')
    }
  }

  return out.join('\n')
}

/** Footer with timings and next-step hints. */
export function renderFooter(result: AnalysisResult, verbose: boolean): string {
  const fixable = result.findings.filter((f) => f.fixable).length
  // Deduplicated per file: several rules can target one asset, and their
  // savings are alternatives rather than additive.
  const recoverable = aggregateRecoverableBytes(result.findings)

  const out: string[] = []

  out.push(
    chalk.gray(
      `Analysed ${pluralize(result.metrics.filesAnalyzed, 'file')} and ` +
        `${pluralize(result.metrics.assetsAnalyzed, 'asset')} with ` +
        `${pluralize(result.metrics.rulesRun, 'rule')} in ` +
        `${formatDuration(result.metrics.durationMs)}`,
    ),
  )

  if (recoverable > 0) {
    out.push(chalk.green(`Estimated ${formatBytes(recoverable)} recoverable`))
  }

  if (fixable > 0) {
    out.push(
      `\n${chalk.magenta('✚')} ${pluralize(fixable, 'finding')} can be fixed automatically: ` +
        `${chalk.bold('npx expopulse fix')}`,
    )
  }

  if (!verbose && result.findings.length > 0) {
    out.push(chalk.gray('Run with --verbose for rationale and recommendations.'))
  }

  if (result.warnings.length > 0) {
    out.push('')
    for (const warning of result.warnings) {
      out.push(`${chalk.yellow('!')} ${chalk.gray(warning)}`)
    }
  }

  if (verbose && Object.keys(result.metrics.analyzerTimings).length > 0) {
    out.push('')
    out.push(chalk.gray('Analyzer timings:'))
    const sorted = Object.entries(result.metrics.analyzerTimings).sort((a, b) => b[1] - a[1])
    for (const [name, ms] of sorted) {
      out.push(chalk.gray(`  ${name.padEnd(12)} ${formatDuration(ms)}`))
    }
  }

  return `${out.join('\n')}\n`
}

/** Full terminal report. */
export function renderTerminalReport(result: AnalysisResult, verbose = false): string {
  return [
    renderHeader(result),
    renderCategoryTable(result),
    renderFindings(result, verbose),
    renderFooter(result, verbose),
  ].join('\n')
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { info: 0, warning: 0, error: 0, critical: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}

/** Light box-drawing characters, matching the rounded boxen border. */
function borderChars() {
  return {
    top: '─',
    'top-mid': '┬',
    'top-left': '╭',
    'top-right': '╮',
    bottom: '─',
    'bottom-mid': '┴',
    'bottom-left': '╰',
    'bottom-right': '╯',
    left: '│',
    'left-mid': '',
    mid: '',
    'mid-mid': '',
    right: '│',
    'right-mid': '',
    middle: '│',
  }
}
