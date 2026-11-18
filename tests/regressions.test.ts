import path from 'node:path'
/**
 * Regression tests for bugs found during initial end-to-end verification.
 * Each test here corresponds to a defect that shipped in a build and was fixed;
 * they exist to stop those specific mistakes coming back.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import {
  type AssetEntry,
  type AssetModel,
  referenceNames,
} from '../packages/core/src/analyzers/assets/index.js'
import { assetsRules } from '../packages/core/src/analyzers/assets/rules.js'
import { codeRules } from '../packages/core/src/analyzers/code/rules.js'
import {
  configPluginPackages,
  packageNameOf,
  stripComments,
} from '../packages/core/src/analyzers/deps/index.js'
import { expoRules } from '../packages/core/src/analyzers/expo/rules.js'
import { compareResults } from '../packages/core/src/core/compare.js'
import { aggregateRecoverableBytes } from '../packages/core/src/core/impact.js'
import { findingKey } from '../packages/core/src/core/rules-engine.js'
import { computeScore } from '../packages/core/src/core/scoring.js'
import { removeSpecifiers } from '../packages/core/src/fixers/code-fixers.js'
import { dedupePermissionLines, sortAppJson } from '../packages/core/src/fixers/config-fixers.js'
import type { AnalysisResult, Finding, FindingDraft } from '../packages/core/src/shared/types.js'

const base = (over: Partial<Finding>): Finding => ({
  ruleId: 'r/x',
  category: 'assets',
  severity: 'warning',
  message: 'm',
  ...over,
})

describe('estimated impact aggregation', () => {
  it('does not double-count several rules targeting one file', () => {
    // A single 5 MB unused image is reported by three rules. Summing their
    // estimates claimed ~10.8 MB recoverable from a 5.8 MB directory.
    const findings = [
      base({ ruleId: 'assets/unused-asset', file: 'a.png', estimatedImpact: { bytes: 5_000_000 } }),
      base({
        ruleId: 'assets/oversized-image',
        file: 'a.png',
        estimatedImpact: { bytes: 3_000_000 },
      }),
      base({ ruleId: 'assets/prefer-webp', file: 'a.png', estimatedImpact: { bytes: 1_500_000 } }),
    ]

    expect(aggregateRecoverableBytes(findings)).toBe(5_000_000)
  })

  it('adds savings across distinct files', () => {
    const findings = [
      base({ file: 'a.png', estimatedImpact: { bytes: 100 } }),
      base({ file: 'b.png', estimatedImpact: { bytes: 250 } }),
    ]
    expect(aggregateRecoverableBytes(findings)).toBe(350)
  })

  it('treats project-level findings as distinct', () => {
    const findings = [
      base({ estimatedImpact: { bytes: 100 } }),
      base({ estimatedImpact: { bytes: 200 } }),
    ]
    expect(aggregateRecoverableBytes(findings)).toBe(300)
  })

  it('ignores missing and non-positive estimates', () => {
    const findings = [
      base({ file: 'a.png' }),
      base({ file: 'b.png', estimatedImpact: { bytes: 0 } }),
      base({ file: 'c.png', estimatedImpact: { note: 'no byte figure' } }),
    ]
    expect(aggregateRecoverableBytes(findings)).toBe(0)
  })
})

describe('findingKey', () => {
  it('is stable when line numbers shift', () => {
    // Deleting a line moved every finding below it, so compare reported the
    // same unchanged issue as both resolved and new.
    const before = base({ file: 'M.xml', location: { line: 9 }, message: 'cleartext enabled' })
    const after = base({ file: 'M.xml', location: { line: 8 }, message: 'cleartext enabled' })

    expect(findingKey(before)).toBe(findingKey(after))
  })

  it('still separates distinct findings from one rule in one file', () => {
    const a = base({ file: 'M.xml', message: 'CAMERA declared twice' })
    const b = base({ file: 'M.xml', message: 'INTERNET declared twice' })

    expect(findingKey(a)).not.toBe(findingKey(b))
  })
})

describe('compareResults', () => {
  const result = (findings: Finding[], overall: number): AnalysisResult => ({
    version: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    root: '/p',
    toolVersion: '0.1.0',
    findings,
    score: { overall, categories: [] },
    metrics: {
      durationMs: 1,
      filesAnalyzed: 1,
      assetsAnalyzed: 0,
      rulesRun: 1,
      analyzerTimings: {},
    },
    warnings: [],
  })

  it('reports a line shift as unchanged, not as added and removed', () => {
    const before = result([base({ file: 'a.xml', location: { line: 9 }, message: 'x' })], 70)
    const after = result([base({ file: 'a.xml', location: { line: 8 }, message: 'x' })], 70)

    const diff = compareResults(before, after)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.unchanged).toHaveLength(1)
  })

  it('detects genuinely resolved and new findings', () => {
    const before = result([base({ file: 'a.ts', message: 'old' })], 60)
    const after = result([base({ file: 'a.ts', message: 'new' })], 80)

    const diff = compareResults(before, after)
    expect(diff.removed.map((f) => f.message)).toEqual(['old'])
    expect(diff.added.map((f) => f.message)).toEqual(['new'])
    expect(diff.scoreDelta).toBe(20)
  })
})

describe('dedupePermissionLines', () => {
  it('keeps the first declaration and drops later copies', () => {
    const xml = [
      '<manifest>',
      '  <uses-permission android:name="android.permission.CAMERA"/>',
      '  <uses-permission android:name="android.permission.INTERNET"/>',
      '  <uses-permission android:name="android.permission.CAMERA"/>',
      '</manifest>',
    ].join('\n')

    const { text, removed } = dedupePermissionLines(xml)
    expect(removed).toBe(1)
    expect(text.match(/CAMERA/g)).toHaveLength(1)
    expect(text).toContain('INTERNET')
  })

  it('leaves a manifest without duplicates untouched', () => {
    const xml = '<manifest>\n  <uses-permission android:name="a.b.C"/>\n</manifest>'
    const { text, removed } = dedupePermissionLines(xml)
    expect(removed).toBe(0)
    expect(text).toBe(xml)
  })

  it('does not touch multi-line declarations it cannot parse safely', () => {
    const xml = [
      '<manifest>',
      '  <uses-permission',
      '    android:name="a.b.C" />',
      '</manifest>',
    ].join('\n')
    const { removed } = dedupePermissionLines(xml)
    expect(removed).toBe(0)
  })
})

describe('sortAppJson', () => {
  it('sorts keys and preserves a trailing newline', () => {
    const sorted = sortAppJson('{"expo":{"slug":"s","name":"n"}}')
    expect(sorted).not.toBeNull()
    expect(sorted?.endsWith('\n')).toBe(true)
    const keys = Object.keys(JSON.parse(sorted as string).expo)
    expect(keys).toEqual(['name', 'slug'])
  })

  it('returns null rather than mangling invalid JSON', () => {
    expect(sortAppJson('{not json')).toBeNull()
  })
})

describe('removeSpecifiers', () => {
  it('removes one named specifier and keeps the rest', () => {
    const line = "import React, { useState, useMemo } from 'react'"
    expect(removeSpecifiers(line, new Set(['useMemo']))).toBe(
      "import React, { useState } from 'react'",
    )
  })

  it('drops the whole statement when nothing is left', () => {
    expect(removeSpecifiers("import { only } from 'x'", new Set(['only']))).toBe('')
  })

  it('keeps the default import when only a named one is unused', () => {
    expect(removeSpecifiers("import a, { b } from 'x'", new Set(['b']))).toBe("import a from 'x'")
  })

  it('matches aliases on the local binding', () => {
    expect(removeSpecifiers("import { a as b, c } from 'x'", new Set(['b']))).toBe(
      "import { c } from 'x'",
    )
  })

  it('refuses to edit a namespace import partially', () => {
    expect(removeSpecifiers("import * as ns from 'x'", new Set(['other']))).toBeNull()
  })

  it('returns null for a line that is not a single-line import', () => {
    expect(removeSpecifiers("const x = require('y')", new Set(['x']))).toBeNull()
  })

  // `import type { A }` has no default binding: the `type` modifier belongs to
  // the statement. Treating it as one produced `import type from './x'`, which
  // is invalid TypeScript — and type-only imports are the most common shape of
  // an unused import, so this corrupted a large share of real projects.
  it('drops a type-only import entirely rather than emitting `import type from`', () => {
    expect(removeSpecifiers("import type { A } from './x'", new Set(['A']))).toBe('')
  })

  it('keeps the type modifier when some specifiers survive', () => {
    expect(removeSpecifiers("import type { A, B } from './x'", new Set(['A']))).toBe(
      "import type { B } from './x'",
    )
  })

  // The suffix capture used to swallow everything after `from`, so rewriting a
  // line with two statements deleted the second one along with the import.
  it('refuses a line holding two import statements', () => {
    expect(
      removeSpecifiers("import { a } from './x'; import { b } from './y'", new Set(['a'])),
    ).toBeNull()
  })

  it('refuses a line where an import shares space with other code', () => {
    expect(removeSpecifiers("import A from './x'; const z = 1", new Set(['A']))).toBeNull()
  })
})

/**
 * The CLI entry guard compared `import.meta.url` against an unresolved
 * `process.argv[1]`. npm and pnpm install `bin` entries as symlinks, so argv[1]
 * was the link path and the comparison never matched: `npx expopulse`, a global
 * install, and `node_modules/.bin/expopulse` all exited 0 with no output, while
 * `node dist/index.js` worked in development. This exercises the real built
 * binary through a symlink, which is the only way to catch it.
 */
describe('CLI entry point', () => {
  it('runs when invoked through a symlinked bin', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const execFileAsync = promisify(execFile)

    const built = path.resolve(__dirname, '../apps/cli/dist/index.js')
    try {
      await fs.access(built)
    } catch {
      // `pnpm build` has not run; the packaged smoke test in CI covers this.
      return
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'expopulse-bin-'))
    const link = path.join(dir, 'expopulse')
    await fs.symlink(built, link)

    const { stdout } = await execFileAsync(process.execPath, [link, '--version'])
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)

    await fs.rm(dir, { recursive: true, force: true })
  })
})

/**
 * A real Expo app scored 49/100 with 1765 findings, and two rules produced
 * most of the noise. Both reported things that are correct by construction, so
 * the fix is suppression at the rule rather than a threshold change.
 */
describe('unused-asset ignores native resource directories', () => {
  const entry = (assetPath: string): AssetEntry => ({
    asset: {
      path: assetPath,
      absolutePath: `/project/${assetPath}`,
      size: 30_000,
      ext: path.extname(assetPath),
      kind: assetPath.endsWith('.ttf') ? 'font' : 'image',
    },
    hash: 'h',
    width: null,
    height: null,
    referenced: false,
  })

  const runUnusedAsset = (paths: string[]): string[] => {
    const rule = assetsRules.find((r) => r.meta.id === 'assets/unused-asset')
    if (!rule) throw new Error('rule not found')
    const model: AssetModel = {
      entries: paths.map(entry),
      sharpAvailable: false,
      searchText: '',
    }
    return rule.check(model, {} as never).map((f) => f.file ?? '')
  }

  it('does not report Android launcher icons Gradle resolves by convention', () => {
    // Deleting these breaks the build; nothing in JS ever names them, so text
    // search called every one of them unused.
    const reported = runUnusedAsset([
      'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp',
      'android/app/src/main/res/mipmap-hdpi/ic_launcher_round.webp',
      'android/app/src/main/res/drawable-xhdpi/notification_icon.png',
      'android/app/src/main/res/drawable/splashscreen_logo.png',
    ])
    expect(reported).toEqual([])
  })

  it('does not report iOS asset-catalog images Xcode reads from the catalog', () => {
    const reported = runUnusedAsset([
      'ios/TruxoTracker/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png',
      'ios/TruxoTracker/Images.xcassets/SplashScreenLogo.imageset/image.png',
    ])
    expect(reported).toEqual([])
  })

  it('still reports genuinely unreferenced JS-side assets', () => {
    const reported = runUnusedAsset([
      'assets/images/splash_logo.png',
      'android/app/src/main/res/mipmap-hdpi/ic_launcher.webp',
    ])
    expect(reported).toEqual(['assets/images/splash_logo.png'])
  })

  it('does not report fonts installed as native resources', () => {
    const rule = assetsRules.find((r) => r.meta.id === 'assets/unused-font')
    if (!rule) throw new Error('rule not found')
    const model: AssetModel = {
      entries: [entry('android/app/src/main/res/font/inter_bold.ttf'), entry('assets/fonts/x.ttf')],
      sharpAvailable: false,
      searchText: '',
    }
    expect(rule.check(model, {} as never).map((f) => f.file)).toEqual(['assets/fonts/x.ttf'])
  })
})

describe('specifier validation', () => {
  /**
   * `from` and `require(` also occur in prose, so a doc comment reading
   * `flipped from "sending" to "failed"` produced an error-severity
   * "sending is imported but not declared in package.json".
   */
  it('rejects specifiers that cannot be package names', () => {
    expect(packageNameOf('tool broke')).toBeNull()
    expect(packageNameOf('${binding.source}')).toBeNull()
    expect(packageNameOf('Sending')).toBeNull()
    expect(packageNameOf('@/hooks')).toBeNull()
  })

  it('still resolves real specifiers to their package name', () => {
    expect(packageNameOf('react-native')).toBe('react-native')
    expect(packageNameOf('date-fns/locale/en-GB')).toBe('date-fns')
    expect(packageNameOf('@react-native-firebase/app')).toBe('@react-native-firebase/app')
  })

  it('strips comments so prose is never scanned for imports', () => {
    const source = [
      '// a row that flips from "sending" to "failed"',
      '/* see require("not-real") for context */',
      `import x from 'real-package'`,
    ].join('\n')

    const stripped = stripComments(source)
    expect(stripped).not.toContain('sending')
    expect(stripped).not.toContain('not-real')
    expect(stripped).toContain('real-package')
  })

  it('keeps string contents that merely look like comments', () => {
    expect(stripComments(`const url = 'https://example.com/x'`)).toContain('https://example.com/x')
  })
})

describe('config plugins count as used dependencies', () => {
  /**
   * A plugin listed in app.config `plugins` is loaded by prebuild but never
   * imported, so `unused-dependency` told users to remove packages whose
   * removal breaks the native build.
   */
  it('treats plugin entries as imported, including tuple form', () => {
    const names = configPluginPackages({
      plugins: [
        'expo-background-task',
        ['react-native-vision-camera', { cameraPermissionText: 'x' }],
        './plugins/withLocalThing',
      ],
    } as never)

    expect([...names].sort()).toEqual(['expo-background-task', 'react-native-vision-camera'])
  })

  it('returns nothing when there is no plugins array', () => {
    expect(configPluginPackages(null).size).toBe(0)
    expect(configPluginPackages({}).size).toBe(0)
  })
})

describe('score damping caps any single rule', () => {
  /**
   * 560 findings from one info-level rule cost ~29 points, which drove the code
   * category to 0 and made the score read as "everything is broken" when one
   * chatty rule was firing.
   */
  it('does not let one noisy rule zero a category', () => {
    const findings = Array.from({ length: 560 }, (_, i) =>
      base({
        ruleId: 'react/no-inline-style',
        category: 'code',
        severity: 'info',
        file: `f${i}.tsx`,
      }),
    )
    const score = computeScore(findings, new Set(['code']))
    const code = score.categories.find((c) => c.category === 'code')
    expect(code?.score).toBeGreaterThanOrEqual(85)
  })

  it('still accumulates penalties across distinct rules', () => {
    const findings = [
      ...Array.from({ length: 50 }, () =>
        base({ ruleId: 'a/x', category: 'code', severity: 'warning' }),
      ),
      ...Array.from({ length: 50 }, () =>
        base({ ruleId: 'b/y', category: 'code', severity: 'warning' }),
      ),
    ]
    const one = computeScore(findings.slice(0, 50), new Set(['code']))
    const two = computeScore(findings, new Set(['code']))
    const scoreOf = (s: typeof one) => s.categories.find((c) => c.category === 'code')?.score ?? 0
    expect(scoreOf(two)).toBeLessThan(scoreOf(one))
  })
})

describe('missing-dependency ignores tsconfig path aliases', () => {
  const analyseImports = async (tsconfig: string, source: string): Promise<Set<string>> => {
    const { collectImports } = await import('../packages/core/src/analyzers/deps/index.js')
    const fs = await import('node:fs/promises')
    const os = await import('node:os')

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'expopulse-deps-'))
    await fs.writeFile(path.join(dir, 'tsconfig.json'), tsconfig, 'utf8')
    const file = path.join(dir, 'a.ts')
    await fs.writeFile(file, source, 'utf8')

    const found = await collectImports({
      project: {
        root: dir,
        sourceFiles: [{ path: 'a.ts', absolutePath: file, size: source.length, ext: '.ts' }],
      },
    } as never)

    await fs.rm(dir, { recursive: true, force: true })
    return found
  }

  /**
   * An Expo app using `@/*` had all 15 of its aliases reported as undeclared
   * packages at error severity — enough to fail CI on a correct project.
   */
  it('does not treat an aliased import as a package', async () => {
    const found = await analyseImports(
      `{"compilerOptions":{"paths":{"@/*":["./app/*"],"@assets/*":["./assets/*"]}}}`,
      `import { a } from '@/hooks'\nimport b from '@assets/images/logo.png'\nimport c from 'react-native'`,
    )
    expect([...found]).toEqual(['react-native'])
  })

  /**
   * The alias `"@/*"` contains the characters `/*`, so stripping block comments
   * with a regex swallowed the rest of the file and the tsconfig silently
   * failed to parse — leaving every alias reported.
   */
  it('parses a tsconfig whose alias contains a block-comment sequence', async () => {
    const found = await analyseImports(
      `{
        // path aliases
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["./app/*"] },
        },
      }`,
      `import { a } from '@/hooks'\nimport c from 'expo'`,
    )
    expect([...found]).toEqual(['expo'])
  })

  it('still reports a genuinely undeclared package', async () => {
    const found = await analyseImports(
      `{"compilerOptions":{"paths":{"@/*":["./app/*"]}}}`,
      `import x from 'some-undeclared-pkg'`,
    )
    expect([...found]).toEqual(['some-undeclared-pkg'])
  })
})

describe('orphaned-config-plugin ignores resolved local plugin functions', () => {
  /**
   * Evaluating app.config.* through @expo/config serialises a
   * `require('./plugins/withX').withX` entry to the bare string "withX" — the
   * function name. It looks exactly like a package name, so the rule told users
   * to install `withSplashScreen` from npm, where no such package exists.
   */
  const runRule = (plugins: unknown[], dependencies: string[]): string[] => {
    const rule = expoRules.find((r) => r.meta.id === 'expo/orphaned-config-plugin')
    if (!rule) throw new Error('rule not found')
    const model = {
      config: { plugins } as never,
      easJson: null,
      packageJson: { name: 'app' } as never,
      root: '/project',
      sdkMajor: 56,
      sdk: null,
      dependencies: new Set(dependencies),
    }
    const findings = rule.check(model as never, {} as never) as FindingDraft[]
    return findings.map((f) => String(f.data?.plugin ?? ''))
  }

  it('does not report camelCase withX function names from a resolved dynamic config', () => {
    expect(
      runRule(['withSplashScreen', 'withFmtConstevalFix', './plugins/withBootTracking'], []),
    ).toEqual([])
  })

  it('still reports a real package plugin that is missing from package.json', () => {
    expect(runRule(['react-native-vision-camera'], [])).toEqual(['react-native-vision-camera'])
  })

  it('does not suppress a declared package that merely starts with "with"', () => {
    // Lowercase after `with` is a package name, not the plugin-function convention.
    expect(runRule(['withings-sdk'], [])).toEqual(['withings-sdk'])
  })
})

describe('require-in-render ignores module-mock factories', () => {
  const findingsFor = async (file: string, source: string): Promise<number> => {
    const { buildCodeModel } = await import('../packages/core/src/analyzers/code/parse.js')
    const fs = await import('node:fs/promises')
    const os = await import('node:os')

    const rule = codeRules.find((r) => r.meta.id === 'performance/require-in-render')
    if (!rule) throw new Error('rule not found')

    // buildCodeModel reads from disk, so the fixture has to be a real file.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'expopulse-rir-'))
    const absolutePath = path.join(dir, path.basename(file))
    await fs.writeFile(absolutePath, source, 'utf8')

    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
    }
    const model = await buildCodeModel(
      [{ path: file, absolutePath, size: source.length, ext: path.extname(file) }],
      logger as never,
    )
    const count = rule.check(model, {} as never).length

    await fs.rm(dir, { recursive: true, force: true })
    return count
  }

  it('does not report require() inside jest.mock factories', async () => {
    // 400 of 416 findings on a real app were this shape. The factory runs once
    // when the registry resolves the module, and hoisting breaks the mock.
    const count = await findingsFor(
      'test/unit/hooks/useSocket.test.ts',
      `jest.mock('@/services/x', () => ({ get: () => require('./fixture').value }))`,
    )
    expect(count).toBe(0)
  })

  it('still reports require() in a render path', async () => {
    const count = await findingsFor(
      'app/components/Row.tsx',
      `export function Row() { const icon = require('./icon.png'); return icon }`,
    )
    expect(count).toBe(1)
  })
})

describe('asset reference names', () => {
  // Metro picks @2x/@3x and .ios/.android variants from the base require(),
  // so `fix` must never treat them as unused when the base name is referenced.
  it('maps density and platform variants to the name source code uses', () => {
    expect(referenceNames('wordmark@2x.png')).toEqual(['wordmark@2x.png', 'wordmark.png'])
    expect(referenceNames('wordmark@1.5x.png')).toContain('wordmark.png')
    expect(referenceNames('logo.ios.png')).toContain('logo.png')
    expect(referenceNames('logo@3x.android.png')).toContain('logo.png')
  })

  it('leaves ordinary names alone', () => {
    expect(referenceNames('hero-banner.png')).toEqual(['hero-banner.png'])
    expect(referenceNames('icon@home.png')).toEqual(['icon@home.png'])
  })
})
