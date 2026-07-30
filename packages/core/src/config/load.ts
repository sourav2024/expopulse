import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { cosmiconfig } from 'cosmiconfig'
import type { ExpoPulseConfig, Logger, Plugin, ResolvedConfig, RuleLevel } from '../shared/types.js'
import { SEVERITIES } from '../shared/types.js'
import {
  DEFAULT_CACHE,
  DEFAULT_CI,
  DEFAULT_FIX,
  DEFAULT_IGNORE,
  DEFAULT_INCLUDE,
  DEFAULT_REPORT,
  DEFAULT_THRESHOLDS,
} from './defaults.js'

const MODULE_NAME = 'expopulse'

/**
 * Load a TS/JS config module by importing it.
 *
 * Node 22.6+ can require/import TypeScript directly with type-stripping, and
 * Node 23.6+ enables it by default. When that is unavailable we surface a
 * clear error rather than a cryptic syntax failure, and suggest the escape
 * hatch of using a .mjs or .json config instead.
 */
async function loadModuleConfig(filepath: string): Promise<ExpoPulseConfig> {
  try {
    // Cache-bust so repeated loads in a watch/test process see edits.
    const url = `${pathToFileURL(filepath).href}?t=${Date.now()}`
    const mod = (await import(url)) as { default?: unknown } & Record<string, unknown>
    const value = mod.default ?? mod
    if (typeof value === 'function') {
      return (await (value as () => ExpoPulseConfig | Promise<ExpoPulseConfig>)()) ?? {}
    }
    return (value as ExpoPulseConfig) ?? {}
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (filepath.endsWith('.ts')) {
      throw new Error(
        `Failed to load ${path.basename(filepath)}: ${reason}\n` +
          'TypeScript config files require Node 22.6+ (with --experimental-strip-types) ' +
          'or Node 23.6+. Alternatively use expopulse.config.mjs or .expopulserc.json.',
      )
    }
    throw new Error(`Failed to load ${path.basename(filepath)}: ${reason}`)
  }
}

/** Search for and parse a config file. Returns defaults when none is found. */
export async function loadConfig(
  root: string,
  overrides: Partial<ExpoPulseConfig> = {},
  logger?: Logger,
): Promise<ResolvedConfig> {
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      'package.json',
      `.${MODULE_NAME}rc`,
      `.${MODULE_NAME}rc.json`,
      `.${MODULE_NAME}rc.js`,
      `.${MODULE_NAME}rc.cjs`,
      `.${MODULE_NAME}rc.mjs`,
      `.${MODULE_NAME}rc.ts`,
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.cjs`,
      `${MODULE_NAME}.config.mjs`,
      `${MODULE_NAME}.config.ts`,
    ],
    loaders: {
      '.ts': (filepath) => loadModuleConfig(filepath),
      '.mjs': (filepath) => loadModuleConfig(filepath),
      '.js': (filepath) => loadModuleConfig(filepath),
      '.cjs': (filepath) => loadModuleConfig(filepath),
    },
    stopDir: root,
  })

  let fileConfig: ExpoPulseConfig = {}
  let configPath: string | null = null

  try {
    const found = await explorer.search(root)
    if (found && !found.isEmpty) {
      fileConfig = (found.config ?? {}) as ExpoPulseConfig
      configPath = found.filepath
      logger?.debug(`loaded config from ${found.filepath}`)
    }
  } catch (err) {
    // A malformed config is a hard error — silently using defaults would
    // make the tool appear to ignore the user's settings.
    throw err instanceof Error ? err : new Error(String(err))
  }

  return resolveConfig(root, fileConfig, overrides, configPath, logger)
}

/** Merge file config and CLI overrides over the defaults. */
export function resolveConfig(
  root: string,
  fileConfig: ExpoPulseConfig,
  overrides: Partial<ExpoPulseConfig> = {},
  configPath: string | null = null,
  logger?: Logger,
): ResolvedConfig {
  const merged: ExpoPulseConfig = {
    ...fileConfig,
    ...overrides,
    // Nested objects merge field-by-field rather than being replaced whole,
    // so `--format json` doesn't discard a configured outDir.
    thresholds: { ...fileConfig.thresholds, ...overrides.thresholds },
    report: { ...fileConfig.report, ...overrides.report },
    fix: { ...fileConfig.fix, ...overrides.fix },
    ci: { ...fileConfig.ci, ...overrides.ci },
    cache: { ...fileConfig.cache, ...overrides.cache },
    rules: { ...fileConfig.rules, ...overrides.rules },
  }

  const rules = validateRules(merged.rules ?? {}, logger)
  const plugins = (merged.plugins ?? []).filter(
    (p): p is Plugin => typeof p === 'object' && p !== null,
  )

  if ((merged.plugins ?? []).some((p) => typeof p === 'string')) {
    // String plugin specifiers require module resolution, which is deferred
    // until the plugin loader lands. Warn rather than fail silently.
    logger?.warn('string plugin specifiers are not yet supported and were skipped')
  }

  return {
    root,
    ignore: [...DEFAULT_IGNORE, ...(merged.ignore ?? [])],
    include: merged.include ?? DEFAULT_INCLUDE,
    rules,
    thresholds: { ...DEFAULT_THRESHOLDS, ...merged.thresholds },
    report: { ...DEFAULT_REPORT, ...merged.report },
    fix: { ...DEFAULT_FIX, ...merged.fix },
    ci: { ...DEFAULT_CI, ...merged.ci },
    cache: { ...DEFAULT_CACHE, ...merged.cache },
    plugins,
    configPath,
  }
}

const VALID_LEVELS = new Set<string>([...SEVERITIES, 'off'])

/** Drop rule entries with unrecognised levels, warning about each. */
function validateRules(
  input: Record<string, RuleLevel>,
  logger?: Logger,
): Record<string, RuleLevel> {
  const out: Record<string, RuleLevel> = {}
  for (const [id, level] of Object.entries(input)) {
    if (VALID_LEVELS.has(level)) {
      out[id] = level
    } else {
      logger?.warn(
        `ignoring invalid level "${String(level)}" for rule "${id}" ` +
          `(expected one of: ${[...VALID_LEVELS].join(', ')})`,
      )
    }
  }
  return out
}

/** Type-safe helper for authoring `expopulse.config.ts`. */
export function defineConfig(config: ExpoPulseConfig): ExpoPulseConfig {
  return config
}
