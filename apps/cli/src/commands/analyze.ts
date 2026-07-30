import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type AnalysisResult,
  type Category,
  type ExpoPulseConfig,
  type ReportFormat,
  SEVERITY_RANK,
  type Severity,
  allAnalyzers,
  analyze,
  createLogger,
  loadConfig,
  renderReport,
  reporters,
} from '@expopulse/core'
import chalk from 'chalk'
import ora from 'ora'
import { type GlobalOptions, resolveRoot } from '../options.js'
import { renderTerminalReport } from '../reporters/terminal.js'

export interface AnalyzeOptions extends GlobalOptions {
  format?: string[]
  only?: string[]
  out?: string
  verbose?: boolean
  failOn?: string
  minScore?: string
  json?: boolean
}

/** Exit codes. Distinct so CI can tell "found issues" from "tool broke". */
export const EXIT_OK = 0
export const EXIT_FINDINGS = 1
export const EXIT_ERROR = 2

export async function runAnalyze(options: AnalyzeOptions): Promise<number> {
  const root = await resolveRoot(options.cwd)
  const logger = createLogger(options.debug ? 'debug' : options.silent ? 'silent' : 'info')

  // `--json` is shorthand for machine-readable output on stdout, which also
  // implies suppressing the spinner and decorative reporting.
  const jsonMode = options.json === true
  const formats = normaliseFormats(options.format, jsonMode)

  const overrides: Partial<ExpoPulseConfig> = {
    report: {
      formats,
      ...(options.out ? { outDir: options.out } : {}),
      ...(options.verbose ? { verbose: true } : {}),
    },
    ...(options.failOn || options.minScore
      ? {
          ci: {
            ...(options.failOn ? { failOn: parseFailOn(options.failOn) } : {}),
            ...(options.minScore ? { enforceScore: true } : {}),
          },
        }
      : {}),
    ...(options.minScore ? { thresholds: { minScore: Number(options.minScore) } } : {}),
    ...(options.noCache ? { cache: { enabled: false } } : {}),
  }

  const config = await loadConfig(root, overrides, logger)

  const spinner =
    jsonMode || options.silent ? null : ora({ text: 'Analysing project…', color: 'cyan' }).start()

  let result: AnalysisResult
  try {
    result = await analyze({
      config,
      logger,
      analyzers: allAnalyzers,
      only: parseCategories(options.only),
    })
    spinner?.stop()
  } catch (err) {
    spinner?.fail('Analysis failed')
    logger.error(err instanceof Error ? err.message : String(err))
    if (options.debug && err instanceof Error) console.error(err.stack)
    return EXIT_ERROR
  }

  await emitReports(result, config.report.formats, config.report.outDir, root, {
    verbose: config.report.verbose,
    jsonMode,
    silent: options.silent === true,
  })

  return decideExitCode(
    result,
    config.ci.failOn,
    config.ci.enforceScore,
    config.thresholds.minScore,
  )
}

/** Write file reports and print terminal/stdout output. */
async function emitReports(
  result: AnalysisResult,
  formats: ReportFormat[],
  outDir: string,
  root: string,
  opts: { verbose: boolean; jsonMode: boolean; silent: boolean },
): Promise<void> {
  const written: string[] = []

  for (const format of formats) {
    if (format === 'cli') {
      if (!opts.silent) process.stdout.write(renderTerminalReport(result, opts.verbose))
      continue
    }

    const rendered = renderReport(result, format)

    // In --json mode the JSON goes to stdout so it can be piped, rather than
    // to a file the caller then has to find.
    if (opts.jsonMode && format === 'json') {
      process.stdout.write(`${rendered}\n`)
      continue
    }

    // `format` is narrowed to a file format here: 'cli' returned above.
    const reporter = reporters[format]
    const filename = `expopulse-report.${reporter.extension}`
    const target = path.resolve(root, outDir, filename)

    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, rendered, 'utf8')
    written.push(path.relative(root, target))
  }

  if (written.length > 0 && !opts.silent && !opts.jsonMode) {
    process.stdout.write(`\n${chalk.gray('Reports written:')}\n`)
    for (const file of written) process.stdout.write(`  ${chalk.cyan(file)}\n`)
    process.stdout.write('\n')
  }
}

/** Decide the process exit code from findings and CI policy. */
export function decideExitCode(
  result: AnalysisResult,
  failOn: Severity | 'never',
  enforceScore: boolean,
  minScore: number,
): number {
  if (enforceScore && result.score.overall < minScore) return EXIT_FINDINGS

  if (failOn === 'never') return EXIT_OK

  const threshold = SEVERITY_RANK[failOn]
  const tripped = result.findings.some((f) => SEVERITY_RANK[f.severity] >= threshold)
  return tripped ? EXIT_FINDINGS : EXIT_OK
}

const VALID_FORMATS = new Set<string>(['cli', 'json', 'markdown', 'html', 'sarif'])

function normaliseFormats(input: string[] | undefined, jsonMode: boolean): ReportFormat[] {
  if (jsonMode) return ['json']
  if (!input || input.length === 0) return ['cli']

  // Commander gives repeated/comma-separated values; accept both spellings.
  const flat = input.flatMap((value) => value.split(',')).map((v) => v.trim().toLowerCase())

  const out: ReportFormat[] = []
  for (const value of flat) {
    if (!VALID_FORMATS.has(value)) {
      throw new Error(
        `unknown report format "${value}" (expected: ${[...VALID_FORMATS].join(', ')})`,
      )
    }
    if (!out.includes(value as ReportFormat)) out.push(value as ReportFormat)
  }
  return out
}

const VALID_CATEGORIES = new Set<string>([
  'code',
  'assets',
  'dependencies',
  'expo',
  'android',
  'ios',
  'bundle',
  'performance',
])

function parseCategories(input: string[] | undefined): Category[] | undefined {
  if (!input || input.length === 0) return undefined

  const flat = input.flatMap((value) => value.split(',')).map((v) => v.trim().toLowerCase())
  const out: Category[] = []

  for (const value of flat) {
    if (!VALID_CATEGORIES.has(value)) {
      throw new Error(`unknown category "${value}" (expected: ${[...VALID_CATEGORIES].join(', ')})`)
    }
    out.push(value as Category)
  }
  return out
}

function parseFailOn(value: string): Severity | 'never' {
  const normalised = value.trim().toLowerCase()
  if (normalised === 'never') return 'never'
  if (['info', 'warning', 'error', 'critical'].includes(normalised)) return normalised as Severity
  throw new Error(
    `invalid --fail-on value "${value}" (expected: info, warning, error, critical, never)`,
  )
}
