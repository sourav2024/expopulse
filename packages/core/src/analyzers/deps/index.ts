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
 * a signal that only needs the string literal. The tradeoff: specifiers inside
 * comments or strings produce false "imported" results, which is the safe
 * direction — it suppresses `unused-dependency` rather than inventing findings.
 */
const IMPORT_RE = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g

/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub/deep` -> `pkg`. */
export function packageNameOf(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  // Node builtin protocol form; the builtin check handles the bare form.
  if (specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    if (parts.length < 2) return null
    return `${parts[0]}/${parts[1]}`
  }
  return parts[0] ?? null
}

async function collectImports(ctx: AnalyzerContext): Promise<Set<string>> {
  const found = new Set<string>()

  const texts = await mapLimit(ctx.project.sourceFiles, READ_LIMIT, async (file) => {
    try {
      return await fs.readFile(file.absolutePath, 'utf8')
    } catch {
      return ''
    }
  })

  for (const text of texts) {
    for (const match of text.matchAll(IMPORT_RE)) {
      const name = packageNameOf(match[1] ?? '')
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

    logger.debug(
      `deps layer collected ${entries.length} dependencies, ` +
        `${importedPackages.size} imported packages`,
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
