import fs from 'node:fs/promises'
import path from 'node:path'
import fg from 'fast-glob'
import { ASSET_EXTENSIONS } from '../config/defaults.js'
import type {
  AssetFile,
  ExpoConfig,
  Logger,
  PackageJson,
  ProjectModel,
  ResolvedConfig,
  SourceFile,
} from '../shared/types.js'
import { parseMajor, toRelative } from '../shared/utils.js'

/** All asset extensions, mapped to their kind for O(1) lookup. */
const EXT_TO_KIND = new Map<string, AssetFile['kind']>()
for (const [kind, exts] of Object.entries(ASSET_EXTENSIONS)) {
  for (const ext of exts) EXT_TO_KIND.set(ext, kind as AssetFile['kind'])
}

const ASSET_GLOB = `**/*{${[...EXT_TO_KIND.keys()].join(',')}}`

/**
 * Walk the project once and build the shared model every analyzer reads from.
 *
 * Doing discovery in one pass matters for the <5s target: the alternative is
 * each of six layers globbing the tree independently.
 */
export async function scanProject(
  config: ResolvedConfig,
  logger: Logger,
): Promise<{ project: ProjectModel; warnings: string[] }> {
  const { root, include, ignore } = config
  const warnings: string[] = []

  const [sourceEntries, assetEntries, packageJson, appJson, easJson, hasAndroidDir, hasIosDir] =
    await Promise.all([
      // followSymbolicLinks: false is load-bearing, not a performance tweak.
      // A symlinked directory would otherwise yield paths that physically live
      // outside the project — which fixers then edit or delete — and a
      // self-referential link produces the same file many times over, inflating
      // both the file count and the scoring penalty.
      fg(include, {
        cwd: root,
        ignore,
        absolute: true,
        onlyFiles: true,
        dot: false,
        stats: true,
        followSymbolicLinks: false,
      }),
      fg(ASSET_GLOB, {
        cwd: root,
        ignore,
        absolute: true,
        onlyFiles: true,
        dot: false,
        stats: true,
        followSymbolicLinks: false,
      }),
      readJson<PackageJson>(path.join(root, 'package.json'), warnings),
      readJson<Record<string, unknown>>(path.join(root, 'app.json'), warnings),
      readJson<Record<string, unknown>>(path.join(root, 'eas.json'), warnings),
      isDirectory(path.join(root, 'android')),
      isDirectory(path.join(root, 'ios')),
    ])

  const sourceFiles: SourceFile[] = sourceEntries.map((entry) => ({
    path: toRelative(root, entry.path),
    absolutePath: entry.path,
    size: entry.stats?.size ?? 0,
    ext: path.extname(entry.path).toLowerCase(),
  }))

  const assets: AssetFile[] = assetEntries.map((entry) => {
    const ext = path.extname(entry.path).toLowerCase()
    return {
      path: toRelative(root, entry.path),
      absolutePath: entry.path,
      size: entry.stats?.size ?? 0,
      ext,
      kind: EXT_TO_KIND.get(ext) ?? 'other',
    }
  })

  const expoConfig = await resolveExpoConfig(root, appJson, warnings, logger)
  const expoSdkMajor = detectSdkMajor(expoConfig, packageJson)

  logger.debug(
    `scanned ${sourceFiles.length} source files, ${assets.length} assets ` +
      `(sdk ${expoSdkMajor ?? 'unknown'})`,
  )

  return {
    project: {
      root,
      sourceFiles,
      assets,
      packageJson,
      appJson,
      expoConfig,
      easJson,
      hasAndroidDir,
      hasIosDir,
      expoSdkMajor,
    },
    warnings,
  }
}

/**
 * Resolve the effective Expo config.
 *
 * `app.config.js/ts` can be dynamic and may read env vars or extend app.json,
 * so evaluating it is not generally safe or even possible statically. We use
 * app.json when present, and note the dynamic config so rules can soften
 * claims that depend on fields it might override.
 */
async function resolveExpoConfig(
  root: string,
  appJson: Record<string, unknown> | null,
  warnings: string[],
  logger: Logger,
): Promise<ExpoConfig | null> {
  const dynamicPath = await firstExisting([
    path.join(root, 'app.config.ts'),
    path.join(root, 'app.config.js'),
    path.join(root, 'app.config.mjs'),
  ])

  // app.json nests real config under an `expo` key; some projects omit it.
  const fromJson = appJson
    ? ((appJson.expo as Record<string, unknown> | undefined) ?? appJson)
    : null

  if (dynamicPath) {
    logger.debug(`found dynamic config at ${toRelative(root, dynamicPath)}`)

    // Prefer the real thing: `@expo/config` runs the same resolution Expo's own
    // CLI does, so a dynamic config that reads env vars or spreads app.json
    // still yields the config the build will actually see. Falling back to
    // app.json silently produced findings that contradicted the real config,
    // and skipping entirely scored the category a misleading 100/100.
    const evaluated = await evaluateDynamicConfig(root, logger)
    if (evaluated) {
      logger.debug('resolved dynamic config via @expo/config')
      return evaluated
    }

    if (!fromJson) {
      warnings.push(
        `${path.basename(dynamicPath)} could not be evaluated and there is no app.json, ` +
          'so Expo configuration checks were skipped. Install `@expo/config` (it ships with ' +
          'expo) or add an app.json for full analysis.',
      )
      return null
    }
    warnings.push(
      `${path.basename(dynamicPath)} could not be evaluated, so Expo findings are based on ` +
        'app.json only and may not reflect values the dynamic config overrides.',
    )
  }

  if (!fromJson) return null
  return fromJson as ExpoConfig
}

/**
 * Evaluate `app.config.*` through Expo's own config resolver.
 *
 * Optional and best-effort: `@expo/config` is a transitive dependency of every
 * Expo app but is not a dependency of this tool, so a missing module, a config
 * that throws on a missing env var, or a native import all mean "fall back"
 * rather than "fail the run". Resolved from the project root so we load the
 * project's copy rather than one hoisted next to the CLI.
 */
async function evaluateDynamicConfig(root: string, logger: Logger): Promise<ExpoConfig | null> {
  try {
    const { createRequire } = await import('node:module')
    // A path inside the project, so require resolution starts there.
    const require = createRequire(path.join(root, 'noop.js'))
    const { getConfig } = require('@expo/config') as {
      getConfig: (
        projectRoot: string,
        options?: { skipSDKVersionRequirement?: boolean; skipPlugins?: boolean },
      ) => { exp: ExpoConfig }
    }

    // getConfig warns on stderr about plugins it cannot resolve (local plugins
    // referenced by path, for instance). That is Expo talking about the user's
    // project mid-analysis, which reads as our output; we surface config
    // problems through findings instead.
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const { exp } = getConfig(root, {
        // A missing SDK version must not abort resolution.
        skipSDKVersionRequirement: true,
        // Plugins are NOT skipped: `skipPlugins` strips the `plugins` array
        // from the result, and the deps layer needs it to know which packages
        // the build loads without importing them.
        skipPlugins: false,
      })
      return exp ?? null
    } finally {
      console.warn = originalWarn
    }
  } catch (err) {
    logger.debug(
      `could not evaluate dynamic config: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/** Determine the Expo SDK major from config, falling back to the dependency. */
function detectSdkMajor(expoConfig: ExpoConfig | null, pkg: PackageJson | null): number | null {
  const fromConfig = parseMajor(expoConfig?.sdkVersion)
  if (fromConfig !== null) return fromConfig
  const dep = pkg?.dependencies?.expo ?? pkg?.devDependencies?.expo
  return parseMajor(dep)
}

async function readJson<T>(filepath: string, warnings: string[]): Promise<T | null> {
  let raw: string
  try {
    raw = await fs.readFile(filepath, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    // The file exists but is invalid — worth telling the user, since it
    // silently disables a whole analysis layer.
    warnings.push(
      `${path.basename(filepath)} is not valid JSON and was ignored: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return null
}
