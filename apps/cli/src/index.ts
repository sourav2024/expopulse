import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { EXIT_ERROR, runAnalyze } from './commands/analyze.js'
import { runCompare } from './commands/compare.js'
import { runDoctor } from './commands/doctor.js'
import { runFix } from './commands/fix.js'
import { runReport } from './commands/report.js'

/**
 * Replaced at build time from package.json via tsup's `define`, so `--version`
 * can never disagree with the published package. The fallback applies only when
 * running the sources directly.
 */
declare const __EXPOPULSE_CLI_VERSION__: string | undefined
const VERSION =
  typeof __EXPOPULSE_CLI_VERSION__ === 'string' ? __EXPOPULSE_CLI_VERSION__ : '0.0.0-dev'

/** Collect repeatable options into an array. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

function withGlobals(command: Command): Command {
  return command
    .option('-c, --cwd <dir>', 'project directory to analyse', process.cwd())
    .option('--debug', 'print debug output and stack traces', false)
    .option('--silent', 'suppress all non-essential output', false)
    .option('--no-cache', 'ignore and do not write the analysis cache')
}

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('expopulse')
    .description(
      'Rule-based static analysis and optimisation platform for Expo applications.\n' +
        'Analyses code, assets, dependencies, configuration and native projects.',
    )
    .version(VERSION, '-v, --version')
    .showHelpAfterError('(run with --help for usage)')

  withGlobals(
    program
      .command('analyze', { isDefault: true })
      .alias('analyse')
      .description('analyse the project and report findings')
      // Values are validated in the command itself, which accepts both
      // `-f html -f json` and `-f html,json`; Commander's `.choices()` would
      // reject the comma-joined form outright.
      .option('-f, --format <format...>', 'output formats: cli, json, markdown, html, sarif')
      .option('--only <category...>', 'restrict analysis to given categories', collect)
      .option('-o, --out <dir>', 'directory for file reports')
      .option('--verbose', 'include rationale and recommendations', false)
      .option('--json', 'print JSON to stdout (implies --format json)', false)
      .option('--fail-on <severity>', 'exit non-zero at or above this severity')
      .option('--min-score <number>', 'exit non-zero below this overall score'),
  ).action(async (options) => {
    process.exitCode = await guard(() => runAnalyze(options))
  })

  withGlobals(
    program
      .command('doctor')
      .description('check the environment and project setup')
      .option('--rules', 'list every available rule instead', false),
  ).action(async (options) => {
    process.exitCode = await guard(() => runDoctor(options))
  })

  withGlobals(
    program
      .command('fix')
      .description('apply safe automatic fixes')
      .option('-n, --dry-run', 'show what would change without writing', false)
      .option('-y, --yes', 'skip the confirmation prompt', false)
      .option('--no-backup', 'do not create a backup before modifying files')
      .option('--webp', 'also convert PNG/JPEG to WebP (updates imports manually)', false)
      .option('--rule <id...>', 'only fix findings from these rules', collect)
      .option('--rollback <id>', 'restore files from a backup session')
      .option('--list-backups', 'list available backup sessions', false),
  ).action(async (options) => {
    process.exitCode = await guard(() => runFix(options))
  })

  withGlobals(
    program
      .command('compare')
      .description('compare the project against a saved baseline')
      .option('-b, --baseline <file>', 'baseline JSON report')
      .option('-a, --against <file>', 'second report (default: analyse live)')
      .option('-s, --save <file>', 'write the current analysis as a baseline'),
  ).action(async (options) => {
    process.exitCode = await guard(() => runCompare(options))
  })

  withGlobals(
    program
      .command('report')
      .description('generate reports in one or more formats')
      // Values are validated in the command itself, which accepts both
      // `-f html -f json` and `-f html,json`; Commander's `.choices()` would
      // reject the comma-joined form outright.
      .option('-f, --format <format...>', 'output formats: cli, json, markdown, html, sarif')
      .option('-o, --out <dir>', 'output directory')
      .option('--from <file>', 'render from a saved JSON report instead of analysing')
      .option('--open', 'open the HTML report when done', false)
      .option('--verbose', 'include rationale and recommendations', false),
  ).action(async (options) => {
    process.exitCode = await guard(() => runReport(options))
  })

  return program
}

/**
 * Run a command, converting thrown errors into a clean message and exit code.
 *
 * Commander's action handlers swallow rejections, so every command is wrapped
 * rather than relying on an unhandledRejection hook.
 */
async function guard(run: () => Promise<number>): Promise<number> {
  try {
    return await run()
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    if (process.env.EXPOPULSE_DEBUG && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`)
    }
    return EXIT_ERROR
  }
}

/** Entry point. Kept separate from `buildProgram` so tests can drive the CLI. */
export async function main(argv: string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv)
}

// Auto-run only when this module is the process entry point, so that importing
// it from a test does not execute the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
