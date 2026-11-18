#!/usr/bin/env node
// Summarise an `expopulse analyze --json` report for triage.
// Zero dependencies. Reads rule buckets from ../references/rules.md so the
// triage map lives in one place.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HELP = `summarize — triage summary of an ExpoPulse JSON report

Usage:
  node summarize.mjs <report.json> [--rule <id>] [--limit <n>] [--json]

  --rule <id>   list every finding of one rule
  --limit <n>   max items per list (default 25)
  --json        machine-readable summary
`

const BUCKETS = {
  B: 'Release blockers',
  R: 'Store-review risk',
  S: 'Size',
  P: 'Runtime performance',
  H: 'Hygiene',
}

export function loadBuckets(rulesMd) {
  const map = new Map()
  for (const m of rulesMd.matchAll(/^\| `([^`]+)` \| (\w+) \| (yes|—) \| ([BRSPH]) \|/gm)) {
    map.set(m[1], { severity: m[2], fixable: m[3] === 'yes', bucket: m[4] })
  }
  return map
}

function bucketOf(f, buckets) {
  if (f.severity === 'critical') return 'B'
  return buckets.get(f.ruleId)?.bucket ?? (f.severity === 'error' ? 'B' : 'H')
}

function fmtBytes(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}

const where = (f) =>
  f.file ? `${f.file}${f.location?.line ? `:${f.location.line}` : ''}` : '(project)'

export function summarize(report, buckets) {
  if (!report || !Array.isArray(report.findings) || !report.score) {
    throw new Error('not an ExpoPulse JSON report (expected findings[] and score)')
  }
  const bySeverity = { critical: 0, error: 0, warning: 0, info: 0 }
  const byRule = new Map()
  const byBucket = { B: [], R: [], S: [], P: [], H: [] }
  const savingsByFile = new Map()
  const savingsByRule = new Map()
  for (const f of report.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
    const r = byRule.get(f.ruleId) ?? {
      ruleId: f.ruleId,
      severity: f.severity,
      count: 0,
      fixable: false,
    }
    r.count++
    r.fixable ||= !!f.fixable
    byRule.set(f.ruleId, r)
    byBucket[bucketOf(f, buckets)].push(f)
    const b = Number(f.estimatedImpact?.bytes) || 0
    if (b > 0) {
      // One file can be unused, oversized and a WebP candidate at once: count it once.
      const key = f.file ?? `${f.ruleId}#${savingsByFile.size}`
      savingsByFile.set(key, Math.max(savingsByFile.get(key) ?? 0, b))
      savingsByRule.set(f.ruleId, (savingsByRule.get(f.ruleId) ?? 0) + b)
    }
  }
  const savings = [...savingsByFile.values()].reduce((t, b) => t + b, 0)
  const rules = [...byRule.values()].sort(
    (a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId),
  )
  return {
    toolVersion: report.toolVersion,
    root: report.root,
    total: report.findings.length,
    score: report.score.overall,
    categories: (report.score.categories ?? []).map((c) => ({
      category: c.category,
      score: c.notApplicable ? null : c.score,
      findings: c.findingCount,
    })),
    bySeverity,
    buckets: Object.fromEntries(Object.entries(byBucket).map(([k, v]) => [k, v.length])),
    blockers: byBucket.B,
    review: byBucket.R,
    rules,
    savings,
    savingsByRule: [...savingsByRule].sort((a, b) => b[1] - a[1]),
    unknownRules: rules.filter((r) => !buckets.has(r.ruleId)).map((r) => r.ruleId),
    warnings: report.warnings ?? [],
  }
}

export function render(s, limit = 25) {
  const out = []
  out.push(`ExpoPulse ${s.toolVersion ?? '?'}: ${s.total} findings, score ${s.score}/100`)
  out.push(
    `Severity: ${s.bySeverity.critical} critical, ${s.bySeverity.error} error, ${s.bySeverity.warning} warning, ${s.bySeverity.info} info`,
  )
  out.push(
    `Categories: ${s.categories.map((c) => `${c.category} ${c.score ?? 'n/a'}`).join(' · ')}`,
  )
  out.push(
    `Buckets: ${Object.entries(s.buckets)
      .map(([k, n]) => `${BUCKETS[k]} ${n}`)
      .join(' · ')}`,
  )
  if (s.warnings.length)
    out.push(
      `Tool warnings: ${s.warnings.map((w) => (typeof w === 'string' ? w : (w.message ?? JSON.stringify(w)))).join(' | ')}`,
    )
  if (s.unknownRules.length)
    out.push(`Rules not in references/rules.md (newer ExpoPulse?): ${s.unknownRules.join(', ')}`)
  const list = (title, items) => {
    out.push('', `## ${title} (${items.length})`)
    if (!items.length) out.push('none')
    for (const f of items.slice(0, limit))
      out.push(`- [${f.severity}] ${f.ruleId} — ${where(f)} — ${f.message}`)
    if (items.length > limit)
      out.push(`- … ${items.length - limit} more (use --rule <id> or --limit)`)
  }
  list(BUCKETS.B, s.blockers)
  list(BUCKETS.R, s.review)
  out.push(
    '',
    `## Estimated savings: ${fmtBytes(s.savings)} (static estimate, each file counted once; not a build measurement)`,
  )
  for (const [rule, b] of s.savingsByRule.slice(0, 10)) out.push(`- ${rule}: ${fmtBytes(b)}`)
  out.push('', '## Findings by rule')
  out.push('| Rule | Severity | Count | Auto-fix |', '|---|---|---|---|')
  for (const r of s.rules.slice(0, Math.max(limit, 15)))
    out.push(`| ${r.ruleId} | ${r.severity} | ${r.count} | ${r.fixable ? 'yes' : '—'} |`)
  if (s.rules.length > Math.max(limit, 15))
    out.push(`| … ${s.rules.length - Math.max(limit, 15)} more rules | | | |`)
  return out.join('\n')
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      rule: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help || !positionals[0]) {
    process.stdout.write(HELP)
    return values.help ? 0 : 2
  }
  const limit = values.limit === undefined ? 25 : Number(values.limit)
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error(`--limit must be a positive integer, got "${values.limit}"`)
  let report
  try {
    report = JSON.parse(readFileSync(positionals[0], 'utf8'))
  } catch (e) {
    throw new Error(`cannot read ${positionals[0]}: ${e.message}`)
  }
  const rulesMd = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'rules.md'),
    'utf8',
  )
  const buckets = loadBuckets(rulesMd)
  if (values.rule) {
    const hits = (report.findings ?? []).filter((f) => f.ruleId === values.rule)
    const meta = buckets.get(values.rule)
    process.stdout.write(
      `${values.rule}: ${hits.length} finding(s)${meta ? ` · bucket ${BUCKETS[meta.bucket]}` : ''}\n`,
    )
    if (hits[0]?.recommendation) process.stdout.write(`Recommendation: ${hits[0].recommendation}\n`)
    for (const f of hits.slice(0, limit))
      process.stdout.write(
        `- ${where(f)} — ${f.message}${f.excerpt ? `\n    ${String(f.excerpt).trim().slice(0, 160)}` : ''}\n`,
      )
    if (hits.length > limit)
      process.stdout.write(`- … ${hits.length - limit} more (raise --limit)\n`)
    return 0
  }
  const s = summarize(report, buckets)
  process.stdout.write(`${values.json ? JSON.stringify(s, null, 2) : render(s, limit)}\n`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`summarize: ${e.message}\n`)
    process.exitCode = 2
  }
}
