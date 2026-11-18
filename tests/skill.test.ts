import fs from 'node:fs'
import path from 'node:path'
import type { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { buildProgram } from '../apps/cli/src/index.js'
import { allRules } from '../packages/core/src/analyzers/index.js'
// @ts-expect-error: plain ESM script without type declarations
import { loadBuckets, summarize } from '../skills/expopulse/scripts/summarize.mjs'

/**
 * The agent skill in skills/expopulse documents CLI flags, rule IDs, severities
 * and a pinned version. These tests fail when the code moves and the skill
 * does not, so the skill can never teach an agent a flag or rule that is gone.
 */

const ROOT = path.resolve(__dirname, '..')
const SKILL_DIR = path.join(ROOT, 'skills', 'expopulse')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const skillMd = read('skills/expopulse/SKILL.md')
const rulesMd = read('skills/expopulse/references/rules.md')
const skillFiles = [
  'skills/expopulse/SKILL.md',
  ...fs
    .readdirSync(path.join(SKILL_DIR, 'references'))
    .map((f) => `skills/expopulse/references/${f}`),
]
const cliVersion = JSON.parse(read('apps/cli/package.json')).version as string

function frontmatter(): Record<string, string> {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skillMd)
  expect(fm, 'SKILL.md frontmatter').not.toBeNull()
  const meta: Record<string, string> = {}
  for (const line of fm?.[1].split('\n') ?? []) {
    const m = /^\s*([a-z-]+):\s*(.*)$/.exec(line)
    if (m) meta[m[1]] = m[2].replace(/^"|"$/g, '')
  }
  return meta
}

describe('agent skill', () => {
  it('has valid frontmatter matching the directory', () => {
    const meta = frontmatter()
    expect(meta.name).toBe('expopulse')
    expect(meta.name).toBe(path.basename(SKILL_DIR))
    expect(meta.description.length).toBeGreaterThan(50)
    expect(meta.description.length).toBeLessThanOrEqual(1024)
    expect(meta.compatibility.length).toBeLessThanOrEqual(500)
    expect(skillMd.split('\n').length).toBeLessThan(500)
  })

  it('versions agree: skill metadata, plugin manifest, packages and every pinned npx call', () => {
    expect(frontmatter().version).toBe(cliVersion)
    expect(JSON.parse(read('packages/core/package.json')).version).toBe(cliVersion)
    expect(JSON.parse(read('.claude-plugin/plugin.json')).version).toBe(cliVersion)
    for (const f of skillFiles) {
      for (const m of read(f).matchAll(/expopulse@(\d+\.\d+\.\d+)/g)) {
        expect(m[1], `${f} pins expopulse@${m[1]}`).toBe(cliVersion)
      }
    }
    expect(rulesMd).toContain(`# ExpoPulse rules (${cliVersion})`)
  })

  it('every referenced file exists and every reference is linked from SKILL.md', () => {
    for (const m of skillMd.matchAll(/`((?:references|scripts)\/[\w.-]+)`/g)) {
      expect(fs.existsSync(path.join(SKILL_DIR, m[1])), m[1]).toBe(true)
    }
    for (const f of fs.readdirSync(path.join(SKILL_DIR, 'references'))) {
      expect(skillMd, `references/${f} is never mentioned`).toContain(`references/${f}`)
    }
  })

  it('rules.md lists exactly the rules in the engine, with matching severity and fixability', () => {
    const documented = loadBuckets(rulesMd) as Map<string, { severity: string; fixable: boolean }>
    const actual = allRules()
    expect([...documented.keys()].sort()).toEqual(actual.map((r) => r.meta.id).sort())
    for (const r of actual) {
      const d = documented.get(r.meta.id)
      expect(d?.severity, `${r.meta.id} severity`).toBe(r.meta.severity)
      expect(d?.fixable, `${r.meta.id} fixable`).toBe(!!r.meta.fixable)
    }
    expect(rulesMd).toContain(`All ${actual.length} rules`)
    expect(skillMd).toContain(`all ${actual.length} rules`)
  })

  it('every expopulse CLI flag the skill mentions exists', () => {
    const known = new Set<string>(['--help', '--version'])
    const visit = (c: Command) => {
      for (const o of c.options) if (o.long) known.add(o.long)
      for (const sub of c.commands) visit(sub)
    }
    visit(buildProgram())
    // Flags of other tools that the skill also mentions.
    const foreign = new Set(['--fix', '--noEmit', '--clean', '--stat'])
    for (const f of skillFiles) {
      for (const m of read(f).matchAll(/(?<![\w-])(--[a-z][a-zA-Z-]*)/g)) {
        if (foreign.has(m[1])) continue
        expect(known.has(m[1]), `${f} mentions unknown flag ${m[1]}`).toBe(true)
      }
    }
  })

  it('summarize triages a report and counts each file once in savings', () => {
    const report = {
      toolVersion: cliVersion,
      score: { overall: 70, categories: [{ category: 'assets', score: 60, findingCount: 3 }] },
      warnings: [],
      findings: [
        {
          ruleId: 'android/target-sdk-outdated',
          severity: 'error',
          message: 'old',
          file: 'android/app/build.gradle',
          location: { line: 10 },
        },
        {
          ruleId: 'assets/unused-asset',
          severity: 'warning',
          message: 'unused',
          file: 'a.png',
          fixable: true,
          estimatedImpact: { bytes: 1000 },
        },
        {
          ruleId: 'assets/oversized-image',
          severity: 'warning',
          message: 'big',
          file: 'a.png',
          fixable: true,
          estimatedImpact: { bytes: 600 },
        },
        { ruleId: 'some/new-rule', severity: 'critical', message: 'new' },
      ],
    }
    const s = summarize(report, loadBuckets(rulesMd))
    expect(s.blockers.map((f: { ruleId: string }) => f.ruleId)).toEqual([
      'android/target-sdk-outdated',
      'some/new-rule',
    ])
    expect(s.savings).toBe(1000)
    expect(s.unknownRules).toEqual(['some/new-rule'])
    expect(() => summarize({}, new Map())).toThrow(/not an ExpoPulse JSON report/)
  })
})
