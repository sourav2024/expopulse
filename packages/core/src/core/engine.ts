import path from 'node:path'
import { createFileCache, createNullCache } from '../cache/cache.js'
import type {
  AnalysisResult,
  Analyzer,
  AnalyzerContext,
  Cache,
  Category,
  Finding,
  Logger,
  Plugin,
  ProjectModel,
  ResolvedConfig,
  Rule,
} from '../shared/types.js'
import { isEnabled, runRules, sortFindings } from './rules-engine.js'
import { scanProject } from './scanner.js'
import { computeScore } from './scoring.js'

/**
 * Version reported in results and used to namespace the cache.
 *
 * Replaced at build time from package.json via tsup's `define`, so it can never
 * drift from the published version. The fallback only applies when running the
 * TypeScript sources directly (tests, `tsx`), where no define is applied.
 */
declare const __EXPOPULSE_VERSION__: string | undefined
export const TOOL_VERSION =
  typeof __EXPOPULSE_VERSION__ === 'string' ? __EXPOPULSE_VERSION__ : '0.0.0-dev'

export interface AnalyzeOptions {
  config: ResolvedConfig
  logger: Logger
  /**
   * Analyzers to run. Callers pass the built-in set; tests pass a subset.
   * Plugin-contributed analyzers are appended automatically.
   */
  analyzers: Analyzer<never>[]
  /** Restrict the run to these categories. Empty/absent means all. */
  only?: Category[]
  /** Pre-scanned project model, to avoid re-scanning between commands. */
  project?: ProjectModel
}

/**
 * Run a full analysis.
 *
 * Analyzer layers are independent, so each one's `collect` runs concurrently.
 * Rules then run per-layer against that layer's model.
 */
export async function analyze(options: AnalyzeOptions): Promise<AnalysisResult> {
  const { config, logger } = options
  const started = performance.now()
  const warnings: string[] = []

  const cache: Cache = config.cache.enabled
    ? createFileCache(path.resolve(config.root, config.cache.dir), TOOL_VERSION)
    : createNullCache()

  // Plugins may contribute analyzers and standalone rules before we scan.
  const { analyzers: pluginAnalyzers, looseRules } = await loadPlugins(config, logger, warnings)

  let project: ProjectModel
  if (options.project) {
    project = options.project
  } else {
    const scanned = await scanProject(config, logger)
    project = scanned.project
    warnings.push(...scanned.warnings)
  }

  const selected = selectAnalyzers([...options.analyzers, ...pluginAnalyzers], options.only)

  const analyzerTimings: Record<string, number> = {}
  const findings: Finding[] = []
  const ranCategories = new Set<Category>()
  let rulesRun = 0

  const ruleCtx = { project, config, logger }

  const results = await Promise.all(
    selected.map(async (analyzer) => {
      const analyzerStarted = performance.now()
      const ctx: AnalyzerContext = { root: config.root, project, config, logger, cache }

      try {
        const model = await analyzer.collect(ctx)

        // A null model means the layer does not apply to this project (no
        // ios/ directory, no assets, and so on). Not an error, and not scored.
        if (model === null) {
          logger.debug(`analyzer ${analyzer.name} skipped (not applicable)`)
          return null
        }

        const outcome = await runRules(analyzer.rules, model as never, ruleCtx)

        for (const failure of outcome.errors) {
          warnings.push(`rule ${failure.ruleId} failed: ${failure.error}`)
        }

        return {
          analyzer,
          findings: outcome.findings,
          rulesRun: outcome.rulesRun,
          durationMs: performance.now() - analyzerStarted,
        }
      } catch (err) {
        // One broken layer must not sink the whole run.
        const reason = err instanceof Error ? err.message : String(err)
        warnings.push(`analyzer ${analyzer.name} failed: ${reason}`)
        logger.debug(`analyzer ${analyzer.name} threw`, err)
        return null
      }
    }),
  )

  for (const result of results) {
    if (!result) continue
    findings.push(...result.findings)
    ranCategories.add(result.analyzer.category)

    // An analyzer may emit findings outside its own declared category — the
    // code layer contributes `performance` findings, for instance. Register
    // every category its rules can report, or those findings would land in a
    // category marked "not applicable" and be silently excluded from scoring.
    for (const rule of result.analyzer.rules) {
      // Skip disabled rules: a category whose every rule is off genuinely did
      // not run, and should stay "not applicable" rather than score a
      // meaningless 100.
      if (isEnabled(rule, config)) ranCategories.add(rule.meta.category)
    }

    rulesRun += result.rulesRun
    analyzerTimings[result.analyzer.name] = Math.round(result.durationMs)
  }

  // Plugin rules that aren't attached to an analyzer run against the project
  // model directly, so simple plugins don't need to define a whole layer.
  if (looseRules.length > 0) {
    const outcome = await runRules(looseRules, project as never, ruleCtx)
    findings.push(...outcome.findings)
    rulesRun += outcome.rulesRun
    for (const rule of looseRules) ranCategories.add(rule.meta.category)
    for (const failure of outcome.errors) {
      warnings.push(`rule ${failure.ruleId} failed: ${failure.error}`)
    }
  }

  const sorted = sortFindings(findings)

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    root: config.root,
    toolVersion: TOOL_VERSION,
    findings: sorted,
    score: computeScore(sorted, ranCategories),
    metrics: {
      durationMs: Math.round(performance.now() - started),
      filesAnalyzed: project.sourceFiles.length,
      assetsAnalyzed: project.assets.length,
      rulesRun,
      analyzerTimings,
    },
    warnings,
  }
}

/** Filter analyzers by requested category, warning about unknown selections. */
function selectAnalyzers(analyzers: Analyzer<never>[], only?: Category[]): Analyzer<never>[] {
  if (!only || only.length === 0) return analyzers
  const wanted = new Set(only)
  return analyzers.filter((analyzer) => wanted.has(analyzer.category))
}

interface LoadedPlugins {
  analyzers: Analyzer<never>[]
  looseRules: Rule<never>[]
}

/** Register plugins and collect what they contribute. */
async function loadPlugins(
  config: ResolvedConfig,
  logger: Logger,
  warnings: string[],
): Promise<LoadedPlugins> {
  const analyzers: Analyzer<never>[] = []
  const looseRules: Rule<never>[] = []

  for (const plugin of config.plugins) {
    try {
      await plugin.register?.({ config, logger })
      analyzers.push(...(plugin.analyzers?.() ?? []))
      looseRules.push(...(plugin.rules?.() ?? []))
      logger.debug(`registered plugin ${plugin.name}`)
    } catch (err) {
      // A failing third-party plugin shouldn't break the user's analysis.
      const reason = err instanceof Error ? err.message : String(err)
      warnings.push(`plugin ${plugin.name ?? '<unnamed>'} failed to register: ${reason}`)
    }
  }

  return { analyzers, looseRules }
}

/** Collect every fixer contributed by configured plugins. */
export function pluginFixers(config: ResolvedConfig) {
  return config.plugins.flatMap((plugin: Plugin) => plugin.fixes?.() ?? [])
}
