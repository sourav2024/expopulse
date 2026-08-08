import fs from 'node:fs/promises'
import path from 'node:path'
import type { Analyzer, AnalyzerContext, PackageJson } from '../../shared/types.js'
import { depsRules } from './rules.js'

/** Concurrency cap for filesystem fan-out. */
const READ_LIMIT = 16

/** One dependency, enriched with what we could learn from disk. */
export interface DepEntry {
  name: string
  /** Version range as declared in package.json. */
  range: string
  /** Which manifest field declared it. */
  kind: 'prod' | 'dev' | 'peer'
  /** Installed size in bytes, or null when not installed / not measured. */
  installedBytes: number | null
  /** Truthy `deprecated` field from the package's own package.json. */
  deprecated: string | null
}

export interface DepsModel {
  entries: DepEntry[]
  /** Production dependencies only, the set most rules care about. */
  prod: DepEntry[]
  /** Every dependency name across prod, dev and peer. */
  declared: Set<string>
  /**
   * False when `node_modules` is absent. Size- and deprecation-based rules
   * skip in that case, since they have nothing to measure.
   */
  nodeModulesPresent: boolean
  /** Bare module specifiers found in source, normalised to package names. */
  importedPackages: Set<string>
}

/**
 * Package names referenced by the Expo config's `plugins` array.
 *
 * A config plugin is named as a string (or `[name, options]` tuple) and is
 * never imported from source, so `unused-dependency` reported every one of them
 * as removable — when deleting them breaks prebuild. Reading the real list beats
 * pattern-matching on names, because plugins are not required to follow any
 * naming convention.
 */
export function configPluginPackages(expoConfig: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>()
  const plugins = expoConfig?.plugins
  if (!Array.isArray(plugins)) return names

  for (const plugin of plugins) {
    // Either "name" or ["name", { …options }].
    const raw = typeof plugin === 'string' ? plugin : Array.isArray(plugin) ? plugin[0] : null
    if (typeof raw !== 'string') continue
    // Local plugins are repo paths, not packages.
    if (raw.startsWith('.') || raw.startsWith('/')) continue
    const name = packageNameOf(raw)
    if (name) names.add(name)
  }

  return names
}

/**
 * Run `fn` over `items` with at most `limit` in flight. See the assets
 * analyzer for the rationale; duplicated rather than shared because the two
 * layers are intentionally independent.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      out[index] = await fn(item)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Sum the size of every file under `dir`.
 *
 * Walks breadth-first with a concurrency cap so a large dependency tree does
 * not open thousands of descriptors. Symlinks are not followed: pnpm's store
 * layout would otherwise double-count shared packages, and a cyclic link
 * would hang the walk.
 */
async function directorySize(dir: string): Promise<number> {
  let total = 0
  let frontier = [dir]

  while (frontier.length > 0) {
    const results = await mapLimit(frontier, READ_LIMIT, async (current) => {
      try {
        return await fs.readdir(current, { withFileTypes: true })
      } catch {
        return []
      }
    })

    const next: string[] = []
    const files: string[] = []
    for (const [index, entries] of results.entries()) {
      const parent = frontier[index]
      if (!parent) continue
      for (const entry of entries) {
        const full = path.join(parent, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) next.push(full)
        else if (entry.isFile()) files.push(full)
      }
    }

    // Batch the stats: a serial await-per-file over a big dependency tree costs
    // thousands of round-trips and dominates the layer's runtime.
    const sizes = await mapLimit(files, READ_LIMIT, async (file) => {
      try {
        return (await fs.stat(file)).size
      } catch {
        return 0 // Raced deletion.
      }
    })
    for (const size of sizes) total += size

    frontier = next
  }

  return total
}

async function readDepManifest(dir: string): Promise<PackageJson | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8')
    return JSON.parse(raw) as PackageJson
  } catch {
    return null
  }
}

/**
 * Find bare module specifiers in source text.
 *
 * A regex, not an AST walk. The code analyzer already pays for full Babel
 * parsing; doing it a second time here would roughly double analysis time for
 * a signal that only needs the string literal.
 *
 * The regex alone over-matches: `from` and `require(` also appear in prose
 * inside doc comments and in strings, which produced imports named "sending",
 * "types" and "tool broke". That is harmless for `unused-dependency`, which
 * only ever suppresses findings, but `missing-dependency` turns each one into
 * an error-severity finding — so every match is validated against the npm name
 * grammar by `packageNameOf` before it counts.
 */
const IMPORT_RE = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g

/**
 * A legal npm package name: lowercase, no spaces, and none of the characters
 * that only show up in interpolation or prose.
 *
 * Deliberately stricter than the npm spec on case, because a capitalised
 * specifier in an Expo app is almost always a sentence fragment picked up from
 * a comment rather than a real dependency.
 */
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub/deep` -> `pkg`. */
export function packageNameOf(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  // Node builtin protocol form; the builtin check handles the bare form.
  if (specifier.startsWith('node:')) return null
  // Template interpolation is a computed specifier, not a package.
  if (specifier.includes('${') || specifier.includes('`')) return null
  // No legal specifier contains whitespace; prose matched from a comment does.
  if (/\s/.test(specifier)) return null

  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    if (parts.length < 2) return null
    const scope = (parts[0] ?? '').slice(1)
    const name = parts[1] ?? ''
    if (!PACKAGE_NAME_RE.test(scope) || !PACKAGE_NAME_RE.test(name)) return null
    return `${parts[0]}/${parts[1]}`
  }

  const name = parts[0] ?? ''
  if (!PACKAGE_NAME_RE.test(name)) return null
  return name
}

/**
 * Remove `//` and block comments from JS/TS source, preserving string and
 * template contents so real specifiers survive.
 *
 * Cheaper than a parse and enough for specifier scanning: quotes inside a
 * comment cannot re-open string state because comments are consumed wholesale.
 * Regex literals are not tracked — a `/` inside one is rare in the same
 * expression as an import specifier, and the failure mode is a dropped
 * specifier rather than an invented one.
 */
export function stripComments(text: string): string {
  let out = ''
  let quote: string | null = null
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    const next = text[i + 1] ?? ''

    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      continue
    }

    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }

    if (quote) {
      if (char === '\\') {
        out += char + next
        i++
        continue
      }
      if (char === quote) quote = null
      out += char
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }

    out += char
  }

  return out
}

/**
 * Strip comments and trailing commas from JSONC so `JSON.parse` accepts it.
 *
 * Reuses the JS comment scanner: the naive regex approach corrupts real
 * tsconfigs, because the alias `"@/*"` contains `/*` and a block-comment
 * pattern swallows the rest of the file.
 */
function stripJsonc(text: string): string {
  // Trailing commas are legal in tsconfig but not in JSON.
  return stripComments(text).replace(/,(\s*[}\]])/g, '$1')
}

/**
 * Read the `compilerOptions.paths` aliases declared by the project's tsconfig,
 * as matchers against import specifiers.
 *
 * Without this, an aliased import like `@/hooks` looks exactly like a scoped
 * package named `@/hooks`, and `missing-dependency` reports every alias in the
 * project as an undeclared package — at error severity, which fails CI. Aliases
 * resolve to paths inside the repo and are never installed, so they must be
 * excluded from the imported-package set entirely.
 *
 * Comments are stripped because tsconfig is JSONC in practice. `extends` is not
 * followed: one level covers the common `tsconfig.base.json` + alias-in-leaf
 * layout, and a missed alias only costs us the pre-existing false positive.
 */
async function readPathAliases(root: string): Promise<RegExp[]> {
  const candidates = ['tsconfig.json', 'jsconfig.json']
  const patterns: RegExp[] = []

  for (const candidate of candidates) {
    let raw: string
    try {
      raw = await fs.readFile(path.join(root, candidate), 'utf8')
    } catch {
      continue
    }

    let parsed: { compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> } }
    try {
      parsed = JSON.parse(stripJsonc(raw))
    } catch {
      continue
    }

    for (const alias of Object.keys(parsed.compilerOptions?.paths ?? {})) {
      // `@/*` matches `@/anything`; a bare `@app` matches only itself.
      const escaped = alias.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      patterns.push(new RegExp(`^${escaped.replace(/\*/g, '.*')}$`))
    }

    const baseUrl = parsed.compilerOptions?.baseUrl
    if (typeof baseUrl === 'string') {
      patterns.push(...(await baseUrlPatterns(root, baseUrl)))
    }
  }

  return patterns
}

/**
 * Matchers for imports that resolve against `compilerOptions.baseUrl` rather
 * than through `paths`.
 *
 * With `baseUrl: "."`, `import x from 'types/load'` resolves to `./types/load`
 * — a repo path, not a package — but it is indistinguishable from a real bare
 * specifier by shape alone. So the first segment is matched against directories
 * that actually exist under baseUrl, which keeps a genuinely missing package
 * reported while suppressing root-relative imports.
 *
 * Directories that are themselves package roots are skipped: `node_modules`
 * obviously, and any name that also appears as a declared dependency would
 * otherwise mask a real missing-dependency finding.
 */
async function baseUrlPatterns(root: string, baseUrl: string): Promise<RegExp[]> {
  const baseDir = path.resolve(root, baseUrl)

  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== 'node_modules' && !name.startsWith('.'))
    .map((name) => new RegExp(`^${name.replace(/[.*+^${}()|[\]\\]/g, '\\$&')}(/|$)`))
}

/** Exported for tests: the alias-vs-package distinction is worth pinning down. */
export async function collectImports(ctx: AnalyzerContext): Promise<Set<string>> {
  const found = new Set<string>()

  const [texts, aliases] = await Promise.all([
    mapLimit(ctx.project.sourceFiles, READ_LIMIT, async (file) => {
      try {
        return await fs.readFile(file.absolutePath, 'utf8')
      } catch {
        return ''
      }
    }),
    readPathAliases(ctx.project.root),
  ])

  for (const text of texts) {
    // Comments are stripped first: prose like `flipped from "sending" to …`
    // matches IMPORT_RE and became an error-severity "missing dependency".
    for (const match of stripComments(text).matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? ''
      // Path aliases resolve inside the repo, so they are neither a declared
      // dependency nor a missing one.
      if (aliases.some((pattern) => pattern.test(specifier))) continue
      const name = packageNameOf(specifier)
      if (name) found.add(name)
    }
  }

  return found
}

export const depsAnalyzer: Analyzer<DepsModel> = {
  name: 'deps',
  category: 'dependencies',
  rules: depsRules,

  async collect(ctx: AnalyzerContext): Promise<DepsModel | null> {
    const { root, project, logger } = ctx
    const pkg = project.packageJson

    // Without a manifest there is no dependency graph to reason about.
    if (!pkg) return null

    const declaredEntries: { name: string; range: string; kind: DepEntry['kind'] }[] = [
      ...Object.entries(pkg.dependencies ?? {}).map(([name, range]) => ({
        name,
        range,
        kind: 'prod' as const,
      })),
      ...Object.entries(pkg.devDependencies ?? {}).map(([name, range]) => ({
        name,
        range,
        kind: 'dev' as const,
      })),
      ...Object.entries(pkg.peerDependencies ?? {}).map(([name, range]) => ({
        name,
        range,
        kind: 'peer' as const,
      })),
    ]

    if (declaredEntries.length === 0) return null

    const nodeModules = path.join(root, 'node_modules')
    const nodeModulesPresent = await fs
      .stat(nodeModules)
      .then((stat) => stat.isDirectory())
      .catch(() => false)

    if (!nodeModulesPresent) {
      logger.debug('node_modules absent; dependency size and deprecation rules will be skipped')
    }

    // Peer deps are usually provided by the host and are not worth walking.
    const measurable = declaredEntries.filter((entry) => entry.kind !== 'peer')

    const measured = new Map<string, { installedBytes: number | null; deprecated: string | null }>()
    if (nodeModulesPresent) {
      const results = await mapLimit(measurable, READ_LIMIT, async (entry) => {
        const dir = path.join(nodeModules, entry.name)
        const exists = await fs
          .stat(dir)
          .then((stat) => stat.isDirectory())
          .catch(() => false)
        if (!exists) return { name: entry.name, installedBytes: null, deprecated: null }

        const [installedBytes, manifest] = await Promise.all([
          directorySize(dir),
          readDepManifest(dir),
        ])
        const raw = manifest?.deprecated
        return {
          name: entry.name,
          installedBytes,
          deprecated: typeof raw === 'string' ? raw : raw ? 'This package is deprecated.' : null,
        }
      })
      for (const result of results) {
        measured.set(result.name, {
          installedBytes: result.installedBytes,
          deprecated: result.deprecated,
        })
      }
    }

    const entries: DepEntry[] = declaredEntries.map((entry) => ({
      name: entry.name,
      range: entry.range,
      kind: entry.kind,
      installedBytes: measured.get(entry.name)?.installedBytes ?? null,
      deprecated: measured.get(entry.name)?.deprecated ?? null,
    }))

    const importedPackages = await collectImports(ctx)

    // A config plugin is "used" by the build even though no source imports it.
    // Folding it into the same set means `unused-dependency` needs no special
    // case, and `missing-dependency` correctly flags a plugin that is listed in
    // the config but absent from package.json.
    const pluginPackages = configPluginPackages(
      project.expoConfig as Record<string, unknown> | null,
    )
    for (const name of pluginPackages) importedPackages.add(name)

    logger.debug(
      `deps layer collected ${entries.length} dependencies, ` +
        `${importedPackages.size} imported packages ` +
        `(${pluginPackages.size} from config plugins)`,
    )

    return {
      entries,
      prod: entries.filter((entry) => entry.kind === 'prod'),
      declared: new Set(entries.map((entry) => entry.name)),
      nodeModulesPresent,
      importedPackages,
    }
  },
}
