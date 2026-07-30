import { createRequire } from 'node:module'
import {
  type Rule,
  allRules,
  createLogger,
  loadConfig,
  parseMajor,
  ruleCount,
  scanProject,
} from '@expopulse/core'
import chalk from 'chalk'
import Table from 'cli-table3'
import { type GlobalOptions, looksLikeProject, resolveRoot } from '../options.js'
import { EXIT_ERROR, EXIT_OK } from './analyze.js'

export interface DoctorOptions extends GlobalOptions {
  rules?: boolean
}

/**
 * Environment and setup diagnostics.
 *
 * `doctor` answers "is ExpoPulse able to analyse this project, and what will
 * it look at" — distinct from `analyze`, which reports on the project itself.
 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const logger = createLogger(options.debug ? 'debug' : 'info')

  try {
    const root = await resolveRoot(options.cwd)

    if (options.rules) return listRules()

    const config = await loadConfig(root, {}, logger)
    const { project, warnings } = await scanProject(config, logger)

    const rows: [string, string, string][] = []

    rows.push(['Project root', ok(), root])

    const isProject = await looksLikeProject(root)
    rows.push([
      'package.json',
      isProject ? ok() : bad(),
      isProject ? (project.packageJson?.name ?? 'unnamed') : 'not found',
    ])

    const expoDep =
      project.packageJson?.dependencies?.expo ?? project.packageJson?.devDependencies?.expo
    rows.push([
      'Expo',
      expoDep ? ok() : warn(),
      expoDep
        ? `${expoDep}${project.expoSdkMajor ? ` (SDK ${project.expoSdkMajor})` : ''}`
        : 'not an Expo project',
    ])

    const rn = project.packageJson?.dependencies?.['react-native']
    rows.push(['React Native', rn ? ok() : warn(), rn ?? 'not found'])

    rows.push([
      'Expo config',
      project.expoConfig ? ok() : warn(),
      project.expoConfig ? 'app.json' : 'not resolved (dynamic config?)',
    ])

    rows.push(['eas.json', project.easJson ? ok() : dash(), project.easJson ? 'present' : 'absent'])

    rows.push([
      'Native dirs',
      dash(),
      [project.hasAndroidDir ? 'android/' : null, project.hasIosDir ? 'ios/' : null]
        .filter(Boolean)
        .join(' ') || 'none (managed workflow)',
    ])

    rows.push(['Source files', ok(), String(project.sourceFiles.length)])
    rows.push(['Assets', ok(), String(project.assets.length)])

    rows.push([
      'Config file',
      config.configPath ? ok() : dash(),
      config.configPath ? config.configPath.replace(`${root}/`, '') : 'using defaults',
    ])

    rows.push(['Rules available', ok(), String(ruleCount())])

    const disabled = Object.values(config.rules).filter((level) => level === 'off').length
    if (disabled > 0) rows.push(['Rules disabled', warn(), String(disabled)])

    // Node version gates whether TypeScript config files can load at all.
    const nodeMajor = parseMajor(process.versions.node) ?? 0
    rows.push([
      'Node',
      nodeMajor >= 20 ? ok() : bad(),
      `v${process.versions.node}${nodeMajor >= 20 ? '' : ' (requires >=20)'}`,
    ])

    rows.push(['Sharp (image fixes)', ...(await checkSharp())])

    const table = new Table({
      head: [chalk.gray('Check'), '', chalk.gray('Detail')],
      style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
    })
    for (const row of rows) table.push(row)

    process.stdout.write(`\n${chalk.bold('ExpoPulse Doctor')}\n\n${table.toString()}\n`)

    if (warnings.length > 0) {
      process.stdout.write(`\n${chalk.yellow('Warnings')}\n`)
      for (const warning of warnings) process.stdout.write(`  ${chalk.gray('•')} ${warning}\n`)
    }

    if (!isProject) {
      process.stdout.write(
        `\n${chalk.red('✖')} No package.json found. Run ExpoPulse from your project root.\n`,
      )
      return EXIT_ERROR
    }

    process.stdout.write(`\n${chalk.green('✔')} Ready. Run ${chalk.bold('expopulse analyze')}.\n\n`)
    return EXIT_OK
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_ERROR
  }
}

/** Print every registered rule, grouped by category. */
function listRules(): number {
  const rules = allRules()
  const byCategory = new Map<string, Rule<never>[]>()

  for (const rule of rules) {
    const list = byCategory.get(rule.meta.category)
    if (list) list.push(rule)
    else byCategory.set(rule.meta.category, [rule])
  }

  process.stdout.write(`\n${chalk.bold(`ExpoPulse Rules (${rules.length})`)}\n`)

  for (const [category, group] of [...byCategory].sort()) {
    process.stdout.write(`\n${chalk.bold.underline(category.toUpperCase())}\n`)
    for (const rule of group.sort((a, b) => a.meta.id.localeCompare(b.meta.id))) {
      const severity = paintSeverity(rule.meta.severity)
      const fixable = rule.meta.fixable ? chalk.magenta(' ✚') : ''
      process.stdout.write(`  ${severity}  ${chalk.cyan(rule.meta.id)}${fixable}\n`)
      process.stdout.write(`         ${chalk.gray(rule.meta.description)}\n`)
    }
  }

  process.stdout.write(`\n${chalk.magenta('✚')} ${chalk.gray('= auto-fixable')}\n\n`)
  return EXIT_OK
}

function paintSeverity(severity: string): string {
  switch (severity) {
    case 'critical':
      return chalk.bgRed.white(' CRIT ')
    case 'error':
      return chalk.red(' ERROR')
    case 'warning':
      return chalk.yellow('  WARN')
    default:
      return chalk.blue('  INFO')
  }
}

/**
 * Report whether sharp loads, since image fixes silently no-op without it.
 *
 * sharp is a dependency of @expopulse/core, not of the CLI, so it is resolved
 * from core's location rather than imported directly — the CLI must not claim
 * a dependency it does not declare.
 */
async function checkSharp(): Promise<[string, string]> {
  try {
    // Resolve from core's package.json rather than its ESM entry point:
    // `require.resolve` on the entry fails because core's `exports` map
    // intentionally declares no `require` condition.
    const require = createRequire(import.meta.url)
    const coreManifest = require.resolve('@expopulse/core/package.json')
    createRequire(coreManifest).resolve('sharp')
    return [ok(), 'available']
  } catch {
    return [warn(), 'unavailable — image compression will be skipped']
  }
}

const ok = () => chalk.green('✔')
const bad = () => chalk.red('✖')
const warn = () => chalk.yellow('!')
const dash = () => chalk.gray('–')
