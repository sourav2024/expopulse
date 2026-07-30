import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type AnalysisResult,
  type ReportFormat,
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
import { EXIT_ERROR, EXIT_OK } from './analyze.js'

export interface ReportOptions extends GlobalOptions {
  format?: string[]
  out?: string
  from?: string
  open?: boolean
  verbose?: boolean
}

/**
 * Generate reports, optionally from a saved JSON result.
 *
 * `--from` lets CI analyse once and render several formats afterwards without
 * paying for the analysis again.
 */
export async function runReport(options: ReportOptions): Promise<number> {
  const logger = createLogger(options.debug ? 'debug' : options.silent ? 'silent' : 'info')

  try {
    const root = await resolveRoot(options.cwd)
    const config = await loadConfig(root, {}, logger)

    let result: AnalysisResult
    if (options.from) {
      result = await readResult(root, options.from)
    } else {
      const spinner = options.silent ? null : ora('Analysing project…').start()
      result = await analyze({ config, logger, analyzers: allAnalyzers })
      spinner?.stop()
    }

    const formats = normaliseFormats(options.format ?? ['html'])
    const outDir = options.out ?? config.report.outDir
    const written: string[] = []

    for (const format of formats) {
      if (format === 'cli') {
        process.stdout.write(renderTerminalReport(result, options.verbose === true))
        continue
      }

      const rendered = renderReport(result, format)
      // `format` is narrowed to a file format here: 'cli' returned above.
      const target = path.resolve(root, outDir, `expopulse-report.${reporters[format].extension}`)

      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, rendered, 'utf8')
      written.push(target)
    }

    if (written.length > 0 && !options.silent) {
      process.stdout.write(`\n${chalk.green('✔')} ${chalk.bold('Reports generated')}\n\n`)
      for (const file of written) {
        process.stdout.write(`  ${chalk.cyan(path.relative(root, file))}\n`)
      }
      process.stdout.write('\n')
    }

    // Opening a file is a side effect the user must ask for explicitly.
    if (options.open) {
      const html = written.find((file) => file.endsWith('.html'))
      if (html) await openInBrowser(html, logger)
      else logger.warn('--open requires an html report; none was generated')
    }

    return EXIT_OK
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_ERROR
  }
}

const VALID_FORMATS = new Set<string>(['cli', 'json', 'markdown', 'html', 'sarif'])

function normaliseFormats(input: string[]): ReportFormat[] {
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

  return out.length > 0 ? out : ['html']
}

async function readResult(root: string, file: string): Promise<AnalysisResult> {
  const target = path.resolve(root, file)

  let raw: string
  try {
    raw = await fs.readFile(target, 'utf8')
  } catch {
    throw new Error(`could not read ${file}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }

  const candidate = parsed as Partial<AnalysisResult>
  if (!Array.isArray(candidate.findings) || typeof candidate.score?.overall !== 'number') {
    throw new Error(`${file} is not an ExpoPulse JSON report`)
  }

  return candidate as AnalysisResult
}

/** Open a file with the platform's default handler. */
async function openInBrowser(file: string, logger: ReturnType<typeof createLogger>): Promise<void> {
  const { spawn } = await import('node:child_process')
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'

  try {
    spawn(command, [file], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    }).unref()
  } catch {
    logger.warn(`could not open ${file} automatically`)
  }
}
