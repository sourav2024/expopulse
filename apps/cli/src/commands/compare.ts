import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type AnalysisResult,
  allAnalyzers,
  analyze,
  compareResults,
  createLogger,
  formatBytes,
  loadConfig,
  pluralize,
} from '@expopulse/core'
import chalk from 'chalk'
import ora from 'ora'
import { type GlobalOptions, resolveRoot } from '../options.js'
import { EXIT_ERROR, EXIT_OK } from './analyze.js'

export interface CompareOptions extends GlobalOptions {
  /** Path to a baseline JSON report. */
  baseline?: string
  /** Path to a second report; when absent, the project is analysed live. */
  against?: string
  /** Write the current analysis as a new baseline. */
  save?: string
}

/**
 * Diff two analysis runs.
 *
 * The common workflow is `--baseline` against a live analysis, which answers
 * "did my changes make things better or worse".
 */
export async function runCompare(options: CompareOptions): Promise<number> {
  const logger = createLogger(options.debug ? 'debug' : options.silent ? 'silent' : 'info')

  try {
    const root = await resolveRoot(options.cwd)
    const config = await loadConfig(
      root,
      options.noCache ? { cache: { enabled: false } } : {},
      logger,
    )

    // `--save` alone means "record the current state as a baseline".
    if (options.save && !options.baseline) {
      const spinner = options.silent ? null : ora('Analysing project…').start()
      const result = await analyze({ config, logger, analyzers: allAnalyzers })
      spinner?.stop()
      await writeBaseline(root, options.save, result)
      process.stdout.write(
        `${chalk.green('✔')} Baseline saved to ${chalk.cyan(options.save)} ` +
          chalk.gray(`(score ${result.score.overall})`) +
          '\n',
      )
      return EXIT_OK
    }

    if (!options.baseline) {
      logger.error('--baseline <file> is required (or use --save <file> to create one)')
      return EXIT_ERROR
    }

    const before = await readResult(root, options.baseline)

    let after: AnalysisResult
    if (options.against) {
      after = await readResult(root, options.against)
    } else {
      const spinner = options.silent ? null : ora('Analysing project…').start()
      after = await analyze({ config, logger, analyzers: allAnalyzers })
      spinner?.stop()
    }

    printComparison(before, after)

    if (options.save) {
      await writeBaseline(root, options.save, after)
      process.stdout.write(chalk.gray(`\nBaseline updated: ${options.save}\n`))
    }

    return EXIT_OK
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_ERROR
  }
}

function printComparison(before: AnalysisResult, after: AnalysisResult): void {
  const diff = compareResults(before, after)

  const arrow =
    diff.scoreDelta > 0 ? chalk.green('▲') : diff.scoreDelta < 0 ? chalk.red('▼') : chalk.gray('=')
  const deltaText =
    diff.scoreDelta === 0
      ? chalk.gray('no change')
      : diff.scoreDelta > 0
        ? chalk.green(`+${diff.scoreDelta}`)
        : chalk.red(String(diff.scoreDelta))

  process.stdout.write(`\n${chalk.bold('Comparison')}\n\n`)
  process.stdout.write(
    `  Score  ${chalk.gray(String(diff.scoreBefore))} → ${chalk.bold(String(diff.scoreAfter))}  ${arrow} ${deltaText}\n`,
  )
  process.stdout.write(
    `  Findings  ${chalk.gray(String(before.findings.length))} → ${chalk.bold(String(after.findings.length))}\n`,
  )

  if (diff.categories.length > 0) {
    process.stdout.write(`\n${chalk.bold('By category')}\n`)
    for (const entry of diff.categories.sort((a, b) => a.delta - b.delta)) {
      const sign = entry.delta > 0 ? chalk.green(`+${entry.delta}`) : chalk.red(String(entry.delta))
      process.stdout.write(
        `  ${entry.category.padEnd(14)} ${String(entry.before).padStart(3)} → ${String(entry.after).padStart(3)}  ${sign}\n`,
      )
    }
  }

  if (diff.removed.length > 0) {
    process.stdout.write(`\n${chalk.green(`Resolved (${diff.removed.length})`)}\n`)
    for (const finding of diff.removed.slice(0, 20)) {
      process.stdout.write(
        `  ${chalk.green('−')} ${chalk.gray(finding.ruleId)} ${finding.file ?? ''}\n`,
      )
    }
    if (diff.removed.length > 20) {
      process.stdout.write(chalk.gray(`  … and ${diff.removed.length - 20} more\n`))
    }
  }

  if (diff.added.length > 0) {
    process.stdout.write(`\n${chalk.red(`New (${diff.added.length})`)}\n`)
    for (const finding of diff.added.slice(0, 20)) {
      process.stdout.write(
        `  ${chalk.red('+')} ${chalk.gray(finding.ruleId)} ${finding.file ?? ''}\n`,
      )
      process.stdout.write(`    ${finding.message}\n`)
    }
    if (diff.added.length > 20) {
      process.stdout.write(chalk.gray(`  … and ${diff.added.length - 20} more\n`))
    }
  }

  const bytesDelta = diff.bytesBefore - diff.bytesAfter
  if (bytesDelta !== 0) {
    const label =
      bytesDelta > 0
        ? chalk.green(`${formatBytes(bytesDelta)} less waste`)
        : chalk.red(`${formatBytes(-bytesDelta)} more waste`)
    process.stdout.write(`\n  Estimated impact: ${label}\n`)
  }

  if (diff.added.length === 0 && diff.removed.length === 0) {
    process.stdout.write(`\n${chalk.gray('No findings changed.')}\n`)
  }

  process.stdout.write(
    `\n${chalk.gray(`${pluralize(diff.unchanged.length, 'finding')} unchanged`)}\n\n`,
  )
}

/** Read and validate a saved analysis result. */
async function readResult(root: string, file: string): Promise<AnalysisResult> {
  const target = path.resolve(root, file)

  let raw: string
  try {
    raw = await fs.readFile(target, 'utf8')
  } catch {
    throw new Error(`could not read report: ${file}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }

  // Validate the shape rather than trusting it — a mismatched file would
  // otherwise produce a confusing crash deep inside the diff.
  const candidate = parsed as Partial<AnalysisResult>
  if (!Array.isArray(candidate.findings) || typeof candidate.score?.overall !== 'number') {
    throw new Error(`${file} is not an ExpoPulse JSON report`)
  }

  if (candidate.version !== 1) {
    throw new Error(
      `${file} was produced by an incompatible version (schema ${String(candidate.version)}); ` +
        're-generate the baseline',
    )
  }

  return candidate as AnalysisResult
}

async function writeBaseline(root: string, file: string, result: AnalysisResult): Promise<void> {
  const target = path.resolve(root, file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}
