/**
 * @expopulse/core — analysis engine, rules, fixers and reporters.
 *
 * This is the package's entire public API. The CLI, the GitHub Action and the
 * VS Code extension all consume it from here.
 */

// Types — the contract plugin authors implement against.
export type {
  AnalysisMetrics,
  AnalysisResult,
  Analyzer,
  AnalyzerContext,
  AssetFile,
  Cache,
  CacheConfig,
  Category,
  CategoryScore,
  CiConfig,
  EstimatedImpact,
  ExpoConfig,
  ExpoPulseConfig,
  Finding,
  FindingDraft,
  FixAction,
  FixConfig,
  FixContext,
  FixPlan,
  FixResult,
  Fixer,
  Logger,
  PackageJson,
  Plugin,
  PluginRegisterContext,
  ProjectModel,
  ReportConfig,
  ReportFormat,
  ResolvedConfig,
  Rule,
  RuleContext,
  RuleLevel,
  RuleMeta,
  Score,
  Severity,
  SourceFile,
  SourceLocation,
  Thresholds,
} from './shared/types.js'

export { CATEGORIES, REPORT_FORMATS, SEVERITIES, SEVERITY_RANK } from './shared/types.js'

// Shared utilities, re-exported because reporters and plugins need them.
export {
  clamp,
  formatBytes,
  formatDuration,
  groupBy,
  parseMajor,
  pluralize,
  sumBy,
  toRelative,
  truncate,
} from './shared/utils.js'

export { createLogger, silentLogger, type LogLevel } from './shared/logger.js'

// Configuration.
export { defineConfig, loadConfig, resolveConfig } from './config/load.js'
export {
  ASSET_EXTENSIONS,
  DEFAULT_CACHE,
  DEFAULT_CI,
  DEFAULT_FIX,
  DEFAULT_IGNORE,
  DEFAULT_INCLUDE,
  DEFAULT_REPORT,
  DEFAULT_THRESHOLDS,
} from './config/defaults.js'

// Engine.
export { analyze, pluginFixers, TOOL_VERSION, type AnalyzeOptions } from './core/engine.js'
export { scanProject } from './core/scanner.js'
export { computeScore, scoreBand } from './core/scoring.js'
export { aggregateRecoverableBytes, largestContributors } from './core/impact.js'
export {
  effectiveLevel,
  findingKey,
  isEnabled,
  runRules,
  sortFindings,
  type RunRulesOutcome,
} from './core/rules-engine.js'

// Analyzers.
export { allAnalyzers, allRules, analyzerByCategory, ruleCount } from './analyzers/index.js'

// Fixers.
export { builtinFixers, planFixes, runFixes, type FixRunSummary } from './fixers/fix-engine.js'
export {
  createBackupSession,
  listBackups,
  rollbackSession,
  type BackupSession,
} from './fixers/backup.js'

// Reporters. The `cli` format is implemented by the CLI package, which owns
// the terminal-presentation dependencies.
export { renderReport, reporters, type Reporter } from './reporters/index.js'

// Comparison of two runs.
export { compareResults, type Comparison } from './core/compare.js'
