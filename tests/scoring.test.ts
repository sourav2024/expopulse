import { describe, expect, it } from 'vitest'
import { computeScore, scoreBand } from '../packages/core/src/core/scoring.js'
import type { Category, Finding, Severity } from '../packages/core/src/shared/types.js'

function finding(
  overrides: Partial<Finding> & { category: Category; severity: Severity },
): Finding {
  return {
    ruleId: overrides.ruleId ?? 'test/rule',
    message: overrides.message ?? 'a problem',
    ...overrides,
  }
}

describe('computeScore', () => {
  it('returns 100 when nothing ran', () => {
    const score = computeScore([], new Set())
    expect(score.overall).toBe(100)
    expect(score.categories.every((c) => c.notApplicable)).toBe(true)
  })

  it('scores a clean category at 100 without marking it n/a', () => {
    const score = computeScore([], new Set<Category>(['code']))
    const code = score.categories.find((c) => c.category === 'code')
    expect(code?.score).toBe(100)
    expect(code?.notApplicable).toBe(false)
  })

  it('penalises by severity, with critical costing most', () => {
    const ran = new Set<Category>(['code'])
    const info = computeScore([finding({ category: 'code', severity: 'info' })], ran)
    const warning = computeScore([finding({ category: 'code', severity: 'warning' })], ran)
    const error = computeScore([finding({ category: 'code', severity: 'error' })], ran)
    const critical = computeScore([finding({ category: 'code', severity: 'critical' })], ran)

    expect(info.overall).toBeGreaterThan(warning.overall)
    expect(warning.overall).toBeGreaterThan(error.overall)
    expect(error.overall).toBeGreaterThan(critical.overall)
  })

  it('excludes categories that did not run from the overall score', () => {
    // iOS findings must not drag down a project with no ios/ directory.
    const findings = [finding({ category: 'ios', severity: 'critical' })]
    const score = computeScore(findings, new Set<Category>(['code']))

    expect(score.overall).toBe(100)
    expect(score.categories.find((c) => c.category === 'ios')?.notApplicable).toBe(true)
  })

  it('damps repeat offences of the same rule', () => {
    const ran = new Set<Category>(['code'])
    const many = Array.from({ length: 100 }, () =>
      finding({ category: 'code', severity: 'warning', ruleId: 'react/no-inline-style' }),
    )

    const score = computeScore(many, ran)

    // Without damping this would floor at 0 and stop conveying information.
    expect(score.overall).toBeGreaterThan(0)
  })

  it('damps per rule, so one noisy rule cannot mask a distinct error', () => {
    const ran = new Set<Category>(['code'])
    const noisy = Array.from({ length: 40 }, () =>
      finding({ category: 'code', severity: 'info', ruleId: 'noisy/rule' }),
    )

    const withoutError = computeScore(noisy, ran).overall
    const withError = computeScore(
      [...noisy, finding({ category: 'code', severity: 'error', ruleId: 'other/rule' })],
      ran,
    ).overall

    expect(withError).toBeLessThan(withoutError)
  })

  it('never returns a score outside 0-100', () => {
    const ran = new Set<Category>(['code', 'expo'])
    const brutal = Array.from({ length: 500 }, (_, i) =>
      finding({ category: 'code', severity: 'critical', ruleId: `rule/${i}` }),
    )

    const score = computeScore(brutal, ran)
    expect(score.overall).toBeGreaterThanOrEqual(0)
    expect(score.overall).toBeLessThanOrEqual(100)
  })

  it('counts findings per severity for each category', () => {
    const score = computeScore(
      [
        finding({ category: 'expo', severity: 'error' }),
        finding({ category: 'expo', severity: 'error' }),
        finding({ category: 'expo', severity: 'info' }),
      ],
      new Set<Category>(['expo']),
    )

    const expo = score.categories.find((c) => c.category === 'expo')
    expect(expo?.findingCount).toBe(3)
    expect(expo?.bySeverity.error).toBe(2)
    expect(expo?.bySeverity.info).toBe(1)
    expect(expo?.bySeverity.warning).toBe(0)
  })
})

describe('scoreBand', () => {
  it('maps scores onto bands', () => {
    expect(scoreBand(100)).toBe('excellent')
    expect(scoreBand(90)).toBe('excellent')
    expect(scoreBand(89)).toBe('good')
    expect(scoreBand(75)).toBe('good')
    expect(scoreBand(74)).toBe('fair')
    expect(scoreBand(50)).toBe('fair')
    expect(scoreBand(49)).toBe('poor')
    expect(scoreBand(0)).toBe('poor')
  })
})
