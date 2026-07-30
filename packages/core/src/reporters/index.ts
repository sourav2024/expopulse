import type { AnalysisResult, ReportFormat } from '../shared/types.js'
import { htmlReporter } from './html.js'
import { jsonReporter } from './json.js'
import { markdownReporter } from './markdown.js'
import { sarifReporter } from './sarif.js'

/**
 * A reporter turns a result into a string.
 *
 * Rendering is pure: reporters never touch the filesystem, so the caller owns
 * output paths, encoding and stdout-vs-file. `extension` exists so the caller
 * can name files without a second format switch.
 */
export interface Reporter {
  format: ReportFormat
  /** File extension without the leading dot, e.g. `md`. */
  extension: string
  render(result: AnalysisResult): string
}

/** Formats this package can render. `cli` is intentionally absent. */
export type FileReportFormat = Exclude<ReportFormat, 'cli'>

/**
 * The `cli` format is not here on purpose: the terminal reporter needs chalk and
 * boxen and must know the tty width, so it lives in the CLI app. Keeping those
 * dependencies out of core means core stays usable as a library.
 */
export const reporters: Record<FileReportFormat, Reporter> = {
  json: jsonReporter,
  markdown: markdownReporter,
  html: htmlReporter,
  sarif: sarifReporter,
}

/** Narrow a `ReportFormat` to one this package can render. */
export function isFileReportFormat(format: ReportFormat): format is FileReportFormat {
  return format !== 'cli'
}

/** Look up a reporter, or `undefined` for `cli`. */
export function getReporter(format: ReportFormat): Reporter | undefined {
  return isFileReportFormat(format) ? reporters[format] : undefined
}

/**
 * Render a result in the requested format.
 *
 * Throws for `cli` rather than silently falling back to JSON — a caller asking
 * for terminal output and receiving JSON would be a confusing failure.
 */
export function renderReport(result: AnalysisResult, format: ReportFormat): string {
  const reporter = getReporter(format)

  if (!reporter) {
    throw new Error(
      `The '${format}' reporter is provided by the CLI package (@expopulse/cli), not ` +
        `@expopulse/core. Renderable formats here: ${Object.keys(reporters).join(', ')}.`,
    )
  }

  return reporter.render(result)
}

export { htmlReporter, jsonReporter, markdownReporter, sarifReporter }
