import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allAnalyzers } from '../packages/core/src/analyzers/index.js'
import { resolveConfig } from '../packages/core/src/config/load.js'
import { analyze } from '../packages/core/src/core/engine.js'
import { scanProject } from '../packages/core/src/core/scanner.js'
import { planFixes, runFixes } from '../packages/core/src/fixers/fix-engine.js'
import { silentLogger } from '../packages/core/src/shared/logger.js'
import type { ResolvedConfig } from '../packages/core/src/shared/types.js'

let root: string

/** Build a minimal Expo project on disk. */
async function scaffold(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  // Caching off: tests must observe the tree as it is, not a prior run.
  const resolved = resolveConfig(root, {}, { cache: { enabled: false } })
  return { ...resolved, ...overrides }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'expopulse-test-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('analyze', () => {
  it('produces a well-formed result for an empty directory', async () => {
    const result = await analyze({
      config: config(),
      logger: silentLogger,
      analyzers: allAnalyzers,
    })

    expect(result.version).toBe(1)
    expect(result.findings).toEqual([])
    expect(result.score.overall).toBe(100)
    expect(new Date(result.timestamp).toString()).not.toBe('Invalid Date')
  })

  it('flags a project with real problems', async () => {
    await scaffold({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { expo: '~54.0.0', react: '19.1.0', 'react-native': '0.81.0' },
      }),
      'app.json': JSON.stringify({
        expo: { name: 'App', slug: 'app', android: { package: 'com.a.b' } },
      }),
      'src/App.tsx': [
        "import React, { useState, useMemo } from 'react'",
        "import { View, Text } from 'react-native'",
        'export function App() {',
        '  const [n] = useState(0)',
        '  return <View style={{ flex: 1 }}><Text>{n}</Text></View>',
        '}',
      ].join('\n'),
    })

    const result = await analyze({
      config: config(),
      logger: silentLogger,
      analyzers: allAnalyzers,
    })
    const ids = result.findings.map((f) => f.ruleId)

    expect(ids).toContain('code/unused-import')
    expect(ids).toContain('react/no-inline-style')
    expect(ids).toContain('expo/missing-bundle-identifier')
    expect(result.score.overall).toBeLessThan(100)
  })

  it('marks native layers not applicable without android/ or ios/', async () => {
    await scaffold({ 'package.json': '{"name":"app"}' })

    const result = await analyze({
      config: config(),
      logger: silentLogger,
      analyzers: allAnalyzers,
    })
    const byCategory = new Map(result.score.categories.map((c) => [c.category, c]))

    expect(byCategory.get('android')?.notApplicable).toBe(true)
    expect(byCategory.get('ios')?.notApplicable).toBe(true)
  })

  it('scores a category whose findings come from another layer', async () => {
    // `performance` findings are emitted by the code analyzer. They were once
    // dropped from scoring because no analyzer declares that category.
    await scaffold({
      'package.json': '{"name":"app"}',
      'src/A.tsx': ['export function A() {', "  const m = require('./m')", '  return m', '}'].join(
        '\n',
      ),
    })

    const result = await analyze({
      config: config(),
      logger: silentLogger,
      analyzers: allAnalyzers,
    })
    const perf = result.score.categories.find((c) => c.category === 'performance')

    expect(result.findings.some((f) => f.category === 'performance')).toBe(true)
    expect(perf?.notApplicable).toBe(false)
    expect(perf?.score).toBeLessThan(100)
  })

  it('honours a rule disabled in config', async () => {
    await scaffold({
      'package.json': '{"name":"app"}',
      'src/A.tsx': "import React, { useMemo } from 'react'\nexport const A = () => null\n",
    })

    const withRule = await analyze({
      config: config(),
      logger: silentLogger,
      analyzers: allAnalyzers,
    })
    expect(withRule.findings.some((f) => f.ruleId === 'code/unused-import')).toBe(true)

    const withoutRule = await analyze({
      config: config({ rules: { 'code/unused-import': 'off' } }),
      logger: silentLogger,
      analyzers: allAnalyzers,
    })
    expect(withoutRule.findings.some((f) => f.ruleId === 'code/unused-import')).toBe(false)
  })

  it('applies a configured severity override', async () => {
    await scaffold({
      'package.json': '{"name":"app"}',
      'src/A.tsx': "import React, { useMemo } from 'react'\nexport const A = () => null\n",
    })

    const result = await analyze({
      config: config({ rules: { 'code/unused-import': 'critical' } }),
      logger: silentLogger,
      analyzers: allAnalyzers,
    })

    const finding = result.findings.find((f) => f.ruleId === 'code/unused-import')
    expect(finding?.severity).toBe('critical')
  })

  it('restricts analysis to selected categories', async () => {
    await scaffold({
      'package.json': '{"name":"app"}',
      'app.json': '{"expo":{"name":"A"}}',
      'src/A.tsx': "import React, { useMemo } from 'react'\nexport const A = () => null\n",
    })

    const result = await analyze({
      config: config(),
      logger: silentLogger,
      analyzers: allAnalyzers,
      only: ['expo'],
    })

    expect(result.findings.every((f) => f.category === 'expo')).toBe(true)
  })

  it('survives an unparseable source file', async () => {
    await scaffold({
      'package.json': '{"name":"app"}',
      'src/broken.tsx': 'export function ((( {{{ !!! not valid',
    })

    const result = await analyze({
      config: config(),
      logger: silentLogger,
      analyzers: allAnalyzers,
    })
    expect(result.version).toBe(1)
  })

  it('warns rather than throwing on malformed app.json', async () => {
    await scaffold({ 'package.json': '{"name":"app"}', 'app.json': '{ broken' })

    const { warnings } = await scanProject(config(), silentLogger)
    expect(warnings.some((w) => w.includes('app.json'))).toBe(true)
  })
})

describe('fix planning', () => {
  it('never deletes every copy of a duplicated asset', async () => {
    // duplicate-image and unused-asset both target duplicated unused files.
    // Applied together they once removed the copy meant to be kept.
    const bytes = Buffer.from('identical-content-for-both-copies')
    await scaffold({ 'package.json': '{"name":"app"}' })
    await fs.mkdir(path.join(root, 'assets'), { recursive: true })
    await fs.writeFile(path.join(root, 'assets/a.png'), bytes)
    await fs.writeFile(path.join(root, 'assets/b.png'), bytes)

    const cfg = config()
    const { project } = await scanProject(cfg, silentLogger)
    const result = await analyze({
      config: cfg,
      logger: silentLogger,
      analyzers: allAnalyzers,
      project,
    })

    const { plans } = await planFixes({ result, project, config: cfg, logger: silentLogger })
    const deletions = plans.flatMap((p) => p.actions.filter((a) => a.kind === 'delete'))

    // Each file may be scheduled at most once...
    const files = deletions.map((a) => a.file)
    expect(new Set(files).size).toBe(files.length)
  })

  /** Plan fixes for one rule and return the files it would delete. */
  async function plannedDeletions(ruleId: string): Promise<string[]> {
    const cfg = config()
    const { project } = await scanProject(cfg, silentLogger)
    const result = await analyze({
      config: cfg,
      logger: silentLogger,
      analyzers: allAnalyzers,
      project,
    })
    const { plans } = await planFixes({ result, project, config: cfg, logger: silentLogger })
    return plans
      .filter((p) => p.ruleId === ruleId)
      .flatMap((p) => p.actions.filter((a) => a.kind === 'delete').map((a) => a.file))
  }

  it('never deletes a duplicate copy that source code still requires', async () => {
    // 0.2.0 deleted one of two identical, both-referenced images without
    // updating its require(), leaving a dangling import that broke the bundle.
    const bytes = Buffer.from('identical-content-for-both-copies')
    await scaffold({
      'package.json': '{"name":"app"}',
      'src/App.tsx':
        'export const A = require("../assets/a/logo.png")\n' +
        'export const B = require("../assets/b/logo.png")\n',
    })
    await fs.mkdir(path.join(root, 'assets/a'), { recursive: true })
    await fs.mkdir(path.join(root, 'assets/b'), { recursive: true })
    await fs.writeFile(path.join(root, 'assets/a/logo.png'), bytes)
    await fs.writeFile(path.join(root, 'assets/b/logo.png'), bytes)

    expect(await plannedDeletions('assets/duplicate-image')).toEqual([])
  })

  it('keeps the referenced copy and deletes only the unreferenced duplicate', async () => {
    const bytes = Buffer.from('identical-content-for-both-copies')
    await scaffold({
      'package.json': '{"name":"app"}',
      'src/App.tsx': 'export const A = require("../assets/logo.png")\n',
    })
    await fs.mkdir(path.join(root, 'assets'), { recursive: true })
    await fs.writeFile(path.join(root, 'assets/logo.png'), bytes)
    await fs.writeFile(path.join(root, 'assets/zz-logo-copy.png'), bytes)

    expect(await plannedDeletions('assets/duplicate-image')).toEqual(['assets/zz-logo-copy.png'])
  })

  it('does not modify a file another plan will delete', async () => {
    const bytes = Buffer.alloc(4096, 9)
    await scaffold({ 'package.json': '{"name":"app"}' })
    await fs.mkdir(path.join(root, 'assets'), { recursive: true })
    await fs.writeFile(path.join(root, 'assets/x.png'), bytes)

    const cfg = config()
    const { project } = await scanProject(cfg, silentLogger)
    const result = await analyze({
      config: cfg,
      logger: silentLogger,
      analyzers: allAnalyzers,
      project,
    })

    const { plans } = await planFixes({ result, project, config: cfg, logger: silentLogger })
    const deleted = new Set(
      plans.flatMap((p) => p.actions.filter((a) => a.kind === 'delete').map((a) => a.file)),
    )
    const modified = plans.flatMap((p) =>
      p.actions.filter((a) => a.kind === 'modify').map((a) => a.file),
    )

    for (const file of modified) expect(deleted.has(file)).toBe(false)
  })

  it('writes nothing in dry-run mode', async () => {
    await scaffold({
      'package.json': '{"name":"app"}',
      'src/A.tsx': "import React, { useMemo } from 'react'\nexport const A = () => null\n",
    })

    const cfg = config({ fix: { ...config().fix, dryRun: true } })
    const { project } = await scanProject(cfg, silentLogger)
    const result = await analyze({
      config: cfg,
      logger: silentLogger,
      analyzers: allAnalyzers,
      project,
    })

    const before = await fs.readFile(path.join(root, 'src/A.tsx'), 'utf8')
    const summary = await runFixes({ result, project, config: cfg, logger: silentLogger })
    const after = await fs.readFile(path.join(root, 'src/A.tsx'), 'utf8')

    expect(summary.dryRun).toBe(true)
    expect(summary.filesChanged).toBe(0)
    expect(after).toBe(before)
  })

  it('applies a fix and can roll it back exactly', async () => {
    await scaffold({
      'package.json': '{"name":"app"}',
      'src/A.tsx': "import React, { useMemo } from 'react'\nexport const A = () => null\n",
    })

    const cfg = config({ fix: { ...config().fix, yes: true } })
    const { project } = await scanProject(cfg, silentLogger)
    const result = await analyze({
      config: cfg,
      logger: silentLogger,
      analyzers: allAnalyzers,
      project,
    })

    const original = await fs.readFile(path.join(root, 'src/A.tsx'), 'utf8')
    const summary = await runFixes({ result, project, config: cfg, logger: silentLogger })

    expect(summary.filesChanged).toBeGreaterThan(0)
    const fixed = await fs.readFile(path.join(root, 'src/A.tsx'), 'utf8')
    expect(fixed).not.toBe(original)
    expect(fixed).not.toContain('useMemo')

    const { rollbackSession } = await import('../packages/core/src/fixers/backup.js')
    expect(summary.backupId).toBeTruthy()
    await rollbackSession(root, summary.backupId as string, silentLogger)

    const restored = await fs.readFile(path.join(root, 'src/A.tsx'), 'utf8')
    expect(restored).toBe(original)
  })
})
