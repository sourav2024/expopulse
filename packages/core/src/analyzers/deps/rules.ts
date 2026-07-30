import { builtinModules } from 'node:module'
import type { FindingDraft, Rule, RuleContext } from '../../shared/types.js'
import { formatBytes } from '../../shared/utils.js'
import type { DepsModel } from './index.js'

/** Node builtins, both bare and `node:`-prefixed forms. */
const BUILTINS = new Set<string>([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/**
 * Packages that are legitimately never imported by application code.
 *
 * These are loaded by the Expo/Metro/Babel toolchain, injected by the bundler,
 * or exist only as types. Flagging them as unused is actively harmful: removing
 * `expo` or a config plugin breaks the build in a way that is hard to trace
 * back to this tool.
 */
const NEVER_IMPORTED_ALLOWLIST = new Set([
  'expo',
  'react',
  'react-dom',
  'react-native',
  'react-native-web',
  'expo-router',
  'expo-dev-client',
  'expo-build-properties',
  'expo-updates',
  'expo-splash-screen',
  'expo-system-ui',
  'typescript',
  'jest',
  'jest-expo',
  'eslint',
  'prettier',
])

/** Prefix and pattern rules that complement the exact-name allowlist. */
const ALLOWLIST_PATTERNS: RegExp[] = [
  /^@types\//,
  /^@expo\//,
  /^@babel\//,
  /^babel-/,
  /^metro-/,
  /^@react-native\//,
  /^@react-native-community\//,
  /^eslint-/,
  /^@typescript-eslint\//,
  // Config plugins are referenced from app.json `plugins`, never imported.
  /-config-plugin$/,
  /^expo-.*-plugin$/,
]

function isNeverImported(name: string): boolean {
  if (NEVER_IMPORTED_ALLOWLIST.has(name)) return true
  return ALLOWLIST_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Curated pairs of packages that solve the same problem.
 *
 * Only flagged when both are actually present — having one of them is a normal
 * choice, having both means one is dead weight or the codebase is mid-migration.
 */
const OVERLAPPING_PAIRS: { a: string; b: string; note: string }[] = [
  {
    a: 'moment',
    b: 'dayjs',
    note: 'Both are date libraries. dayjs covers most moment APIs at a fraction of the size.',
  },
  {
    a: 'moment',
    b: 'date-fns',
    note: 'Both are date libraries. date-fns is tree-shakeable; moment is not.',
  },
  {
    a: 'lodash',
    b: 'underscore',
    note: 'Both are utility belts with near-identical APIs.',
  },
  {
    a: 'lodash',
    b: 'ramda',
    note: 'Both are functional utility libraries; standardising on one avoids shipping two.',
  },
  {
    a: 'axios',
    b: 'node-fetch',
    note: 'Two HTTP clients. React Native ships a global fetch, so both may be removable.',
  },
  {
    a: 'uuid',
    b: 'nanoid',
    note: 'Both generate unique ids.',
  },
  {
    a: 'react-native-vector-icons',
    b: '@expo/vector-icons',
    note: '@expo/vector-icons already bundles the vector-icons sets.',
  },
  {
    a: 'async',
    b: 'p-limit',
    note: 'Overlapping async control-flow helpers.',
  },
]

/**
 * Curated lighter replacements. Suggestions only — each one changes call sites,
 * so the rule is `info` and never fixable.
 */
const LIGHTER_ALTERNATIVES: Record<string, string> = {
  moment:
    'Replace with dayjs (same API shape, ~2 KB) or date-fns (tree-shakeable). moment bundles ' +
    'all locales and cannot be tree-shaken.',
  lodash:
    "Use lodash-es, or import per method (`import debounce from 'lodash/debounce'`) so Metro " +
    'only bundles what you use.',
  underscore: 'Prefer native array methods, or per-method lodash imports.',
  uuid:
    "Use crypto.randomUUID() via expo-crypto, or `expo-crypto`'s randomUUID — no extra " +
    'dependency needed.',
  'react-native-vector-icons':
    'Use @expo/vector-icons, which is already part of the Expo SDK and needs no native linking.',
  axios:
    'The global fetch available in React Native covers most cases; a small wrapper is usually ' +
    'lighter than axios.',
  'crypto-js':
    'Use expo-crypto for hashing and random bytes — it delegates to native implementations.',
  'react-native-svg-charts':
    'Prefer victory-native or a hand-rolled react-native-svg chart; this package is unmaintained.',
}

const largeDependency: Rule<DepsModel> = {
  meta: {
    id: 'deps/large-dependency',
    category: 'dependencies',
    severity: 'info',
    description: 'Installed dependency is larger than the configured size threshold',
    rationale:
      'Installed size is not bundle size — much of it is types, docs and source maps that ' +
      'Metro drops. It is still the best available proxy for how much a package brings with ' +
      'it, and large packages usually correlate with large bundle contributions.',
    recommendation: 'Check whether a lighter alternative or a narrower import path exists.',
  },

  check(model: DepsModel, ctx: RuleContext): FindingDraft[] {
    if (!model.nodeModulesPresent) return []
    const limit = ctx.config.thresholds.maxDependencyBytes

    return model.prod
      .filter((entry) => entry.installedBytes !== null && entry.installedBytes > limit)
      .sort((a, b) => (b.installedBytes ?? 0) - (a.installedBytes ?? 0))
      .map((entry) => ({
        message:
          `${entry.name} occupies ${formatBytes(entry.installedBytes ?? 0)} installed, ` +
          `over the ${formatBytes(limit)} threshold`,
        estimatedImpact: {
          note:
            'Installed size, not shipped size. Only the parts your code reaches end up in the ' +
            'bundle, so no byte estimate is claimed.',
        },
        data: { name: entry.name, installedBytes: entry.installedBytes, limit },
      }))
  },
}

const duplicateFunctionality: Rule<DepsModel> = {
  meta: {
    id: 'deps/duplicate-functionality',
    category: 'dependencies',
    severity: 'info',
    description: 'Two dependencies that solve the same problem are both installed',
    rationale:
      'Both libraries ship, so the app pays twice for one capability. This usually means a ' +
      'migration was started and not finished.',
    recommendation: 'Standardise on one and remove the other.',
  },

  check(model: DepsModel): FindingDraft[] {
    const present = new Set(model.prod.map((entry) => entry.name))

    return OVERLAPPING_PAIRS.filter((pair) => present.has(pair.a) && present.has(pair.b)).map(
      (pair) => ({
        message: `${pair.a} and ${pair.b} overlap in functionality`,
        rationale: pair.note,
        data: { packages: [pair.a, pair.b] },
      }),
    )
  },
}

const preferLighterAlternative: Rule<DepsModel> = {
  meta: {
    id: 'deps/prefer-lighter-alternative',
    category: 'dependencies',
    severity: 'info',
    description: 'A dependency has a materially lighter, well-supported replacement',
    rationale:
      'On mobile, bundle bytes cost startup time: every KB of JavaScript must be read, parsed ' +
      'and executed before the first screen paints.',
  },

  check(model: DepsModel): FindingDraft[] {
    const findings: FindingDraft[] = []

    for (const entry of model.prod) {
      const suggestion = LIGHTER_ALTERNATIVES[entry.name]
      if (!suggestion) continue
      findings.push({
        message: `${entry.name} has a lighter alternative`,
        recommendation: suggestion,
        data: { name: entry.name, installedBytes: entry.installedBytes },
      })
    }

    return findings
  },
}

const unusedDependency: Rule<DepsModel> = {
  meta: {
    id: 'deps/unused-dependency',
    category: 'dependencies',
    severity: 'warning',
    description: 'Declared dependency is never imported from source',
    rationale:
      'Unused dependencies slow installs and CI, and keep the project exposed to advisories for ' +
      'code it does not run.',
    recommendation: 'Remove it, after confirming nothing loads it indirectly.',
  },

  check(model: DepsModel): FindingDraft[] {
    return model.prod
      .filter((entry) => !isNeverImported(entry.name) && !model.importedPackages.has(entry.name))
      .map((entry) => ({
        message: `${entry.name} is declared but never imported`,
        rationale:
          "Imports are found by scanning source text for `from 'x'` and `require('x')`. " +
          'A package consumed only through a Babel plugin, a Metro transformer, an app.json ' +
          'config plugin, or a native autolink will look unused here even though removing it ' +
          'breaks the build. Toolchain packages (expo, react-native, @expo/*, babel-*, metro-*, ' +
          '@types/*) are already excluded; verify anything else before removing it.',
        data: { name: entry.name, range: entry.range },
      }))
  },
}

const missingDependency: Rule<DepsModel> = {
  meta: {
    id: 'deps/missing-dependency',
    category: 'dependencies',
    severity: 'error',
    description: 'Source imports a package that is not declared in package.json',
    rationale:
      'The build works locally only because the package is hoisted from another dependency. ' +
      'A fresh install, a lockfile refresh, or a stricter package manager will break it.',
    recommendation: 'Add the package to dependencies with an explicit version range.',
  },

  check(model: DepsModel): FindingDraft[] {
    const findings: FindingDraft[] = []

    for (const name of [...model.importedPackages].sort()) {
      if (BUILTINS.has(name)) continue
      if (model.declared.has(name)) continue
      findings.push({
        message: `${name} is imported but not declared in package.json`,
        data: { name },
      })
    }

    return findings
  },
}

const deprecatedPackage: Rule<DepsModel> = {
  meta: {
    id: 'deps/deprecated-package',
    category: 'dependencies',
    severity: 'warning',
    description: 'Installed dependency is marked deprecated by its author',
    rationale:
      'A deprecated package receives no security fixes and typically no new-architecture or SDK ' +
      'compatibility work, so it becomes an upgrade blocker.',
    recommendation: 'Follow the deprecation notice to its replacement.',
  },

  check(model: DepsModel): FindingDraft[] {
    if (!model.nodeModulesPresent) return []

    return model.entries
      .filter((entry) => entry.deprecated !== null)
      .map((entry) => ({
        message: `${entry.name} is deprecated`,
        // The author's own notice is more useful than anything we could write.
        recommendation: entry.deprecated ?? undefined,
        data: { name: entry.name, deprecated: entry.deprecated, kind: entry.kind },
      }))
  },
}

export const depsRules: Rule<DepsModel>[] = [
  largeDependency,
  duplicateFunctionality,
  preferLighterAlternative,
  unusedDependency,
  missingDependency,
  deprecatedPackage,
]
