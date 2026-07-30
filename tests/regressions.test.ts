import path from 'node:path'
/**
 * Regression tests for bugs found during initial end-to-end verification.
 * Each test here corresponds to a defect that shipped in a build and was fixed;
 * they exist to stop those specific mistakes coming back.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { compareResults } from '../packages/core/src/core/compare.js'
import { aggregateRecoverableBytes } from '../packages/core/src/core/impact.js'
import { findingKey } from '../packages/core/src/core/rules-engine.js'
import { removeSpecifiers } from '../packages/core/src/fixers/code-fixers.js'
import { dedupePermissionLines, sortAppJson } from '../packages/core/src/fixers/config-fixers.js'
import type { AnalysisResult, Finding } from '../packages/core/src/shared/types.js'

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
