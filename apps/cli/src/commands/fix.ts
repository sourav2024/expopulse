import readline from 'node:readline/promises'
import {
  type ExpoPulseConfig,
  allAnalyzers,
  analyze,
  createLogger,
  formatBytes,
  listBackups,
  loadConfig,
  pluralize,
  rollbackSession,
  runFixes,
  scanProject,
} from '@expopulse/core'
import chalk from 'chalk'
import ora from 'ora'
import { type GlobalOptions, resolveRoot } from '../options.js'
import { EXIT_ERROR, EXIT_OK } from './analyze.js'

export interface FixOptions extends GlobalOptions {
  dryRun?: boolean
  yes?: boolean
  noBackup?: boolean
  webp?: boolean
  rule?: string[]
  rollback?: string
  listBackups?: boolean
}

export async function runFix(options: FixOptions): Promise<number> {
  const root = await resolveRoot(options.cwd)
  const logger = createLogger(options.debug ? 'debug' : options.silent ? 'silent' : 'info')

  if (options.listBackups) return showBackups(root)
  if (options.rollback) return doRollback(root, options.rollback, logger)

  const overrides: Partial<ExpoPulseConfig> = {
    fix: {
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.yes ? { yes: true } : {}),
      ...(options.noBackup ? { backup: false } : {}),
      ...(options.webp ? { convertToWebp: true } : {}),
    },
    ...(options.noCache ? { cache: { enabled: false } } : {}),
  }

  const config = await loadConfig(root, overrides, logger)

  const spinner = options.silent ? null : ora({ text: 'Analysing project…', color: 'cyan' }).start()

  try {
    // Scan once and reuse the model for both analysis and fixing, so fixers
    // see exactly the tree that produced the findings.
    const { project } = await scanProject(config, logger)
    const result = await analyze({ config, logger, analyzers: allAnalyzers, project })

    spinner?.stop()

    const fixable = result.findings.filter((f) => f.fixable)
    if (fixable.length === 0) {
      process.stdout.write(`${chalk.green('✔')} Nothing to fix.\n`)
      return EXIT_OK
    }

    // Preview first, always. The user sees the exact action list before any
    // write happens, whether or not they passed --dry-run.
    const preview = await runFixes({
      result,
      project,
      config: { ...config, fix: { ...config.fix, dryRun: true } },
      logger,
      onlyRules: options.rule,
    })

    if (preview.plans.length === 0) {
      process.stdout.write(
        `${chalk.yellow('!')} ${pluralize(fixable.length, 'finding')} marked fixable, ` +
          'but no fixer produced a change.\n',
      )
      if (preview.unhandledRules.length > 0) {
        process.stdout.write(
          chalk.gray(`  no fixer registered for: ${preview.unhandledRules.join(', ')}\n`),
        )
      }
      return EXIT_OK
    }

    printPreview(preview)

    if (config.fix.dryRun) {
      process.stdout.write(chalk.gray('\nDry run — no files were modified.\n'))
      return EXIT_OK
    }

    if (!config.fix.yes && !(await confirm())) {
      process.stdout.write(chalk.gray('Aborted. No files were modified.\n'))
      return EXIT_OK
    }

    const applySpinner = options.silent ? null : ora({ text: 'Applying fixes…' }).start()
    const applied = await runFixes({ result, project, config, logger, onlyRules: options.rule })
    applySpinner?.stop()

    printOutcome(applied.filesChanged, applied.totalBytesSaved, applied.backupId)
    return EXIT_OK
  } catch (err) {
    spinner?.fail('Fix failed')
    logger.error(err instanceof Error ? err.message : String(err))
    if (options.debug && err instanceof Error) console.error(err.stack)
    return EXIT_ERROR
  }
}

function printPreview(preview: Awaited<ReturnType<typeof runFixes>>): void {
  const totalActions = preview.plans.reduce((n, plan) => n + plan.actions.length, 0)
  const totalBytes = preview.plans.reduce(
    (n, plan) => n + plan.actions.reduce((m, a) => m + (a.bytesSaved ?? 0), 0),
    0,
  )

  process.stdout.write(`\n${chalk.bold('Planned changes')}\n\n`)

  for (const plan of preview.plans) {
    process.stdout.write(`  ${chalk.gray(plan.ruleId)}\n`)
    for (const action of plan.actions) {
      const verb =
        action.kind === 'delete'
          ? chalk.red('delete')
          : action.kind === 'create'
            ? chalk.green('create')
            : chalk.yellow('modify')
      process.stdout.write(`    ${verb}  ${chalk.cyan(action.file)}\n`)
      process.stdout.write(`            ${chalk.gray(action.description)}\n`)
    }
    process.stdout.write('\n')
  }

  process.stdout.write(
    `  ${pluralize(totalActions, 'change')}` +
      (totalBytes > 0 ? chalk.green(`, ~${formatBytes(totalBytes)} saved`) : '') +
      '\n',
  )

  if (preview.unhandledRules.length > 0) {
    process.stdout.write(chalk.gray(`  no fixer for: ${preview.unhandledRules.join(', ')}\n`))
  }
}

function printOutcome(filesChanged: number, bytesSaved: number, backupId: string | null): void {
  process.stdout.write(
    `\n${chalk.green('✔')} Fixed ${pluralize(filesChanged, 'file')}` +
      (bytesSaved > 0 ? chalk.green(`, saved ${formatBytes(bytesSaved)}`) : '') +
      '\n',
  )
  if (backupId) {
    process.stdout.write(
      chalk.gray(`  backup: ${backupId}\n`) +
        chalk.gray(`  undo with: npx expopulse fix --rollback ${backupId}\n`),
    )
  }
}

/** Ask for confirmation on stdin. Declines automatically when not a TTY. */
async function confirm(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stdout.write(
      chalk.yellow('\n! Not an interactive terminal; pass --yes to apply fixes.\n'),
    )
    return false
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(
      `\n${chalk.bold('Apply these changes?')} ${chalk.gray('(y/N)')} `,
    )
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

async function showBackups(root: string): Promise<number> {
  const backups = await listBackups(root)
  if (backups.length === 0) {
    process.stdout.write(chalk.gray('No backups found.\n'))
    return EXIT_OK
  }
  process.stdout.write(`${chalk.bold('Available backups')}\n\n`)
  for (const id of backups) process.stdout.write(`  ${id}\n`)
  process.stdout.write(chalk.gray('\nRestore with: npx expopulse fix --rollback <id>\n'))
  return EXIT_OK
}

async function doRollback(
  root: string,
  id: string,
  logger: ReturnType<typeof createLogger>,
): Promise<number> {
  try {
    const restored = await rollbackSession(root, id, logger)
    process.stdout.write(`${chalk.green('✔')} Restored ${pluralize(restored, 'file')} from ${id}\n`)
    return EXIT_OK
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_ERROR
  }
}
