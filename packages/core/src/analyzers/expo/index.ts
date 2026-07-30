import fs from 'node:fs'
import path from 'node:path'
import type { Analyzer, AnalyzerContext, ExpoConfig, PackageJson } from '../../shared/types.js'
import { expoRules } from './rules.js'
import { type SdkInfo, getSdkInfo } from './sdk.js'

/**
 * Everything the Expo config rules read.
 *
 * The model is deliberately flat and pre-normalised: user config is arbitrary
 * JSON, so the digging and guarding happens once here rather than in eighteen
 * rules.
 */
export interface ExpoModel {
  /** Resolved Expo config, or null when only a dynamic app.config.* exists. */
  config: ExpoConfig | null
  /** Raw eas.json contents, or null when absent. */
  easJson: Record<string, unknown> | null
  packageJson: PackageJson | null
  /** Absolute project root, for resolving asset paths referenced in config. */
  root: string
  /** Detected SDK major, or null when undeterminable. */
  sdkMajor: number | null
  /** What we know about `sdkMajor`, or null when it is outside our table. */
  sdk: SdkInfo | null
  /** Union of dependencies and devDependencies names, for membership tests. */
  dependencies: Set<string>
  /** Declared version ranges for dependencies we compare against the SDK. */
  reactNativeRange: string | null
  reactRange: string | null
}

/**
 * Read a nested property without assuming any intermediate object exists.
 *
 * Every field on an Expo config is optional and the file is user-authored, so
 * `config.android.adaptiveIcon.foregroundImage` can fail at any of three hops —
 * including on a value that is a string or array where an object was expected.
 */
export function get(obj: unknown, dottedPath: string): unknown {
  let cursor: unknown = obj
  for (const key of dottedPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/** `get` narrowed to a non-empty string, which is what most rules actually want. */
export function getString(obj: unknown, dottedPath: string): string | null {
  const value = get(obj, dottedPath)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** `get` narrowed to a plain object (not an array, not null). */
export function getObject(obj: unknown, dottedPath: string): Record<string, unknown> | null {
  const value = get(obj, dottedPath)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Names of `plugins` entries, handling both config-plugin spellings:
 * `"plugin-name"` and `["plugin-name", { ...options }]`.
 *
 * Inline function plugins (only expressible in app.config.js) and malformed
 * entries are dropped — we cannot name them, so we cannot check them.
 */
export function pluginNames(config: ExpoConfig | null): string[] {
  const raw = config?.plugins
  if (!Array.isArray(raw)) return []

  const names: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      names.push(entry)
      continue
    }
    if (Array.isArray(entry)) {
      const first = entry[0]
      if (typeof first === 'string') names.push(first)
    }
  }
  return names
}

/**
 * True when `assetPath` (as written in app.json) exists on disk.
 *
 * Expo resolves these relative to the project root. We reject absolute paths
 * and anything escaping the root rather than stat-ing outside the project.
 */
export function assetExists(root: string, assetPath: string): boolean {
  // Remote assets are legal in some fields and are not ours to verify.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(assetPath)) return true
  if (path.isAbsolute(assetPath)) return false

  const resolved = path.resolve(root, assetPath)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..')) return false

  try {
    return fs.statSync(resolved).isFile()
  } catch {
    return false
  }
}

function collectDependencies(pkg: PackageJson | null): Set<string> {
  const names = new Set<string>()
  for (const group of [pkg?.dependencies, pkg?.devDependencies]) {
    if (!group) continue
    for (const name of Object.keys(group)) names.add(name)
  }
  return names
}

function depRange(pkg: PackageJson | null, name: string): string | null {
  const value = pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export const expoAnalyzer: Analyzer<ExpoModel> = {
  name: 'expo',
  category: 'expo',
  rules: expoRules,

  async collect(ctx: AnalyzerContext): Promise<ExpoModel | null> {
    const { project, logger } = ctx

    // With neither an app.json-derived config nor an eas.json there is nothing
    // to analyse. The scanner already warned about a dynamic-only config.
    if (project.expoConfig === null && project.easJson === null) {
      logger.debug('expo layer skipped: no resolvable app config and no eas.json')
      return null
    }

    const sdkMajor = project.expoSdkMajor
    const sdk = sdkMajor === null ? null : getSdkInfo(sdkMajor)

    if (sdkMajor !== null && sdk === null) {
      logger.debug(`expo sdk ${sdkMajor} is outside the known table; version rules will skip`)
    }

    return {
      config: project.expoConfig,
      easJson: project.easJson,
      packageJson: project.packageJson,
      root: project.root,
      sdkMajor,
      sdk,
      dependencies: collectDependencies(project.packageJson),
      reactNativeRange: depRange(project.packageJson, 'react-native'),
      reactRange: depRange(project.packageJson, 'react'),
    }
  },
}
