/**
 * Core type contracts for ExpoPulse.
 *
 * This module is the public API surface that plugin authors bind to. Treat
 * changes here as semver-relevant.
 */

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export const SEVERITIES = ['info', 'warning', 'error', 'critical'] as const

export type Severity = (typeof SEVERITIES)[number]

/** Severity ranks, used for sorting and threshold comparisons. */
export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
}

/** A rule's configured level. `off` disables the rule entirely. */
export type RuleLevel = Severity | 'off'

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  'code',
  'assets',
  'dependencies',
  'expo',
  'android',
  'ios',
  'bundle',
  'performance',
] as const

export type Category = (typeof CATEGORIES)[number]

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** A source position. Lines are 1-based, columns 0-based (Babel convention). */
export interface SourceLocation {
  line: number
  column?: number
  endLine?: number
  endColumn?: number
}

/**
 * Estimated impact of a finding. All sizes are in bytes.
 *
 * These are estimates derived from static analysis, not measurements from a
 * real build. Reporters must present them as such.
 */
export interface EstimatedImpact {
  /** Bytes recoverable in the shipped app if this finding is resolved. */
  bytes?: number
  /** Estimated milliseconds saved at startup. */
  startupMs?: number
  /** Free-form note explaining how the estimate was derived. */
  note?: string
}

export interface Finding {
  /** Rule that produced this finding, e.g. `react/no-inline-style`. */
  ruleId: string
  category: Category
  /** Effective severity after config overrides are applied. */
  severity: Severity
  /** One-line statement of the problem. */
  message: string
  /** Why this matters. Shown in verbose and HTML reports. */
  rationale?: string
  /** Concrete action the developer should take. */
  recommendation?: string
  /** Project-relative path. Absent for project-wide findings. */
  file?: string
  location?: SourceLocation
  /** Offending source text or config value, truncated for display. */
  excerpt?: string
  estimatedImpact?: EstimatedImpact
  /** True when a registered fixer can resolve this finding safely. */
  fixable?: boolean
  /** Arbitrary rule-specific payload, passed through to fixers. */
  data?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RuleMeta {
  id: string
  category: Category
  /** Severity used when config does not override it. */
  severity: Severity
  /** One-line description of what the rule detects. */
  description: string
  /** Why the problem matters. */
  rationale?: string
  /** Default recommended fix, when it is the same for every finding. */
  recommendation?: string
  /** Whether an auto-fix exists for findings from this rule. */
  fixable?: boolean
  /** URL to extended documentation. */
  docs?: string
}

/**
 * A rule inspects an already-collected project model and returns findings.
 *
 * Rules must be pure with respect to the filesystem: read from the supplied
 * context, never write. Writing is the fix engine's job.
 */
export interface Rule<TInput = unknown> {
  meta: RuleMeta
  /**
   * Produce findings. May return a partial `Finding` without `ruleId`,
   * `category` or `severity` — the engine fills those in from `meta`.
   */
  check(input: TInput, ctx: RuleContext): FindingDraft[] | Promise<FindingDraft[]>
}

/**
 * What a rule actually returns. The engine stamps identity fields from
 * `Rule.meta`, so rules only describe the specifics of each occurrence.
 */
export type FindingDraft = Omit<Finding, 'ruleId' | 'category' | 'severity'> & {
  /** Override the rule's default severity for this specific occurrence. */
  severity?: Severity
}

export interface RuleContext {
  project: ProjectModel
  config: ResolvedConfig
  logger: Logger
}

// ---------------------------------------------------------------------------
// Analyzers
// ---------------------------------------------------------------------------

/**
 * An analyzer owns one analysis layer. It collects a model of some slice of
 * the project, then runs its rules against that model.
 */
export interface Analyzer<TInput = unknown> {
  name: string
  category: Category
  /** Rules this analyzer contributes. */
  rules: Rule<TInput>[]
  /**
   * Gather the data its rules need. Returning `null` skips the analyzer —
   * used when a layer does not apply (e.g. no `android/` directory).
   */
  collect(ctx: AnalyzerContext): Promise<TInput | null>
}

export interface AnalyzerContext {
  /** Absolute path to the project root. */
  root: string
  project: ProjectModel
  config: ResolvedConfig
  logger: Logger
  cache: Cache
}

// ---------------------------------------------------------------------------
// Project model
// ---------------------------------------------------------------------------

export interface SourceFile {
  /** Project-relative path, POSIX separators. */
  path: string
  /** Absolute path on disk. */
  absolutePath: string
  size: number
  ext: string
}

export interface AssetFile extends SourceFile {
  kind: 'image' | 'font' | 'video' | 'audio' | 'other'
}

export interface PackageJson {
  name?: string
  version?: string
  main?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  scripts?: Record<string, string>
  [key: string]: unknown
}

/** Normalised Expo config, merged from app.json / app.config.{js,ts}. */
export interface ExpoConfig {
  name?: string
  slug?: string
  version?: string
  sdkVersion?: string
  jsEngine?: string
  newArchEnabled?: boolean
  orientation?: string
  icon?: string
  scheme?: string | string[]
  userInterfaceStyle?: string
  splash?: Record<string, unknown>
  updates?: Record<string, unknown>
  runtimeVersion?: string | Record<string, unknown>
  assetBundlePatterns?: string[]
  plugins?: unknown[]
  experiments?: Record<string, unknown>
  android?: Record<string, unknown>
  ios?: Record<string, unknown>
  web?: Record<string, unknown>
  extra?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Everything the scanner discovered about the project. Analyzers read from
 * this rather than hitting the filesystem themselves where possible.
 */
export interface ProjectModel {
  root: string
  /** Source files matched by the include/ignore globs. */
  sourceFiles: SourceFile[]
  /** Static assets discovered under the project. */
  assets: AssetFile[]
  packageJson: PackageJson | null
  /** Raw contents of app.json, if present. */
  appJson: Record<string, unknown> | null
  /** Resolved Expo config, or null if this is not an Expo project. */
  expoConfig: ExpoConfig | null
  easJson: Record<string, unknown> | null
  /** Present when the project has been prebuilt or is bare workflow. */
  hasAndroidDir: boolean
  hasIosDir: boolean
  /** Detected Expo SDK major version, when determinable. */
  expoSdkMajor: number | null
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface Thresholds {
  /** Images larger than this (bytes) are flagged. */
  maxImageBytes: number
  /** Individual assets larger than this (bytes) are flagged. */
  maxAssetBytes: number
  /** Single dependencies larger than this (bytes) are flagged. */
  maxDependencyBytes: number
  /** Minimum overall score for `analyze` to exit 0 in CI mode. */
  minScore: number
}

export interface ReportConfig {
  /** Output formats to emit. */
  formats: ReportFormat[]
  /** Directory for file-based reports, relative to project root. */
  outDir: string
  /** Include passing checks in output. */
  verbose: boolean
}

export const REPORT_FORMATS = ['cli', 'json', 'markdown', 'html', 'sarif'] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]

export interface FixConfig {
  /** Write a backup before modifying any file. */
  backup: boolean
  /** Skip the interactive confirmation prompt. */
  yes: boolean
  /** Report what would change without writing. */
  dryRun: boolean
  /** Convert PNG/JPEG to WebP. Off by default: changes file extensions. */
  convertToWebp: boolean
}

export interface CiConfig {
  /** Fail the run when findings at or above this severity exist. */
  failOn: Severity | 'never'
  /** Fail when the overall score is below `thresholds.minScore`. */
  enforceScore: boolean
}

export interface CacheConfig {
  enabled: boolean
  /** Cache directory, relative to project root. */
  dir: string
}

/** User-facing config shape. Every field is optional. */
export interface ExpoPulseConfig {
  /** Extra glob patterns to exclude from analysis. */
  ignore?: string[]
  /** Glob patterns defining which source files to analyse. */
  include?: string[]
  /** Per-rule severity overrides. `off` disables the rule. */
  rules?: Record<string, RuleLevel>
  thresholds?: Partial<Thresholds>
  report?: Partial<ReportConfig>
  fix?: Partial<FixConfig>
  ci?: Partial<CiConfig>
  cache?: Partial<CacheConfig>
  plugins?: (string | Plugin)[]
}

/** Config after defaults are applied. What the engine actually consumes. */
export interface ResolvedConfig {
  root: string
  ignore: string[]
  include: string[]
  rules: Record<string, RuleLevel>
  thresholds: Thresholds
  report: ReportConfig
  fix: FixConfig
  ci: CiConfig
  cache: CacheConfig
  plugins: Plugin[]
  /** Path the config was loaded from, or null when using defaults. */
  configPath: string | null
}

// ---------------------------------------------------------------------------
// Fixers
// ---------------------------------------------------------------------------

/** A single filesystem mutation a fixer intends to perform. */
export interface FixAction {
  kind: 'modify' | 'delete' | 'create'
  /** Project-relative path. */
  file: string
  /** Human-readable summary, e.g. "compress 1.2 MB -> 340 KB". */
  description: string
  /** Bytes saved by this action, when applicable. */
  bytesSaved?: number
}

export interface FixPlan {
  ruleId: string
  findings: Finding[]
  actions: FixAction[]
}

export interface FixResult {
  ruleId: string
  applied: FixAction[]
  failed: { action: FixAction; error: string }[]
  bytesSaved: number
}

/**
 * A fixer resolves findings from one rule.
 *
 * `plan` must be side-effect free; `apply` performs the writes. The engine
 * always calls `plan` first so `--dry-run` and previews are exact.
 */
export interface Fixer {
  /** Rule this fixer resolves. */
  ruleId: string
  /** Whether this fix is safe to apply without human review. */
  safe: boolean
  plan(findings: Finding[], ctx: FixContext): Promise<FixPlan>
  apply(plan: FixPlan, ctx: FixContext): Promise<FixResult>
}

export interface FixContext {
  root: string
  project: ProjectModel
  config: ResolvedConfig
  logger: Logger
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export interface Plugin {
  name: string
  /** Called once at startup, before any analysis. */
  register?(ctx: PluginRegisterContext): void | Promise<void>
  analyzers?(): Analyzer<never>[]
  rules?(): Rule<never>[]
  fixes?(): Fixer[]
}

export interface PluginRegisterContext {
  config: ResolvedConfig
  logger: Logger
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface CategoryScore {
  category: Category
  /** 0-100. */
  score: number
  findingCount: number
  /** Number of findings per severity. */
  bySeverity: Record<Severity, number>
  /** True when no rules ran for this category (layer not applicable). */
  notApplicable: boolean
}

export interface Score {
  /** 0-100 weighted overall score. */
  overall: number
  categories: CategoryScore[]
}

// ---------------------------------------------------------------------------
// Analysis result
// ---------------------------------------------------------------------------

export interface AnalysisMetrics {
  /** Wall-clock duration of the analysis, in milliseconds. */
  durationMs: number
  filesAnalyzed: number
  assetsAnalyzed: number
  rulesRun: number
  /** Per-analyzer timings, for `--profile`. */
  analyzerTimings: Record<string, number>
}

export interface AnalysisResult {
  /** Schema version of this result object, for `compare` compatibility. */
  version: 1
  /** ISO-8601 timestamp of when the analysis ran. */
  timestamp: string
  root: string
  /** ExpoPulse version that produced the result. */
  toolVersion: string
  findings: Finding[]
  score: Score
  metrics: AnalysisMetrics
  /** Non-fatal problems encountered during analysis. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Support services
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export interface Cache {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  clear(): Promise<void>
}
