import type { AnalysisResult, CategoryScore, Finding, Severity } from '../shared/types.js'
import { SEVERITY_RANK } from '../shared/types.js'
import { formatBytes, formatDuration, groupBy, pluralize, truncate } from '../shared/utils.js'
import type { Reporter } from './index.js'

/**
 * Escape text for interpolation into HTML.
 *
 * Findings carry arbitrary source excerpts, file paths and rule-supplied
 * messages, so every single interpolation in this file goes through here.
 * Quotes are escaped too because some of these values land in attributes.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Score bands. Kept in one place so the gauge and the bars cannot disagree. */
function band(score: number): 'good' | 'warn' | 'bad' {
  if (score >= 90) return 'good'
  if (score >= 75) return 'warn'
  return 'bad'
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --border: #e2e5ea;
  --text: #1a1d23;
  --muted: #5f6672;
  --accent: #2563eb;
  --good: #15803d;
  --warn: #b45309;
  --bad: #b91c1c;
  --good-bg: #dcfce7;
  --warn-bg: #fef3c7;
  --bad-bg: #fee2e2;
  --track: #e6e9ee;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.1);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --surface: #171a21;
    --border: #272b34;
    --text: #e6e8ec;
    --muted: #9aa2b1;
    --accent: #60a5fa;
    --good: #4ade80;
    --warn: #fbbf24;
    --bad: #f87171;
    --good-bg: #14321f;
    --warn-bg: #3a2c0c;
    --bad-bg: #3b1517;
    --track: #272b34;
    --shadow: none;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 2rem 1.25rem 4rem;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial,
    'Apple Color Emoji', sans-serif;
  font-size: 15px;
  line-height: 1.55;
  /* Wide content is confined to its own scroll container, so the page itself
     must never scroll sideways. */
  overflow-x: hidden;
}

main { max-width: 1080px; margin: 0 auto; }

code, .mono {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.87em;
}

h1 { font-size: 1.6rem; margin: 0 0 0.25rem; letter-spacing: -0.02em; }
h2 { font-size: 1.15rem; margin: 0 0 0.75rem; letter-spacing: -0.01em; }
.sub { color: var(--muted); margin: 0; font-size: 0.92rem; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
  margin-bottom: 1.25rem;
  box-shadow: var(--shadow);
}

header.card { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; }
header .titles { flex: 1 1 16rem; min-width: 0; }
header .titles p { overflow-wrap: anywhere; }

/* Gauge: an SVG ring is used instead of conic-gradient because stroke-dasharray
   renders identically in older WebKit and in print. */
.gauge { flex: 0 0 auto; position: relative; width: 132px; height: 132px; }
.gauge svg { transform: rotate(-90deg); display: block; }
.gauge .track { stroke: var(--track); }
.gauge .value { transition: none; stroke-linecap: round; }
.gauge figcaption {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
}
.gauge .num { font-size: 2.1rem; font-weight: 650; letter-spacing: -0.03em; line-height: 1; }
.gauge .of {
  font-size: 0.7rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.good { color: var(--good); }
.warn { color: var(--warn); }
.bad { color: var(--bad); }
.stroke-good { stroke: var(--good); }
.stroke-warn { stroke: var(--warn); }
.stroke-bad { stroke: var(--bad); }

.bars { display: grid; gap: 0.7rem; }
.bar-row {
  display: grid;
  grid-template-columns: minmax(6rem, 9rem) 1fr auto;
  gap: 0.75rem;
  align-items: center;
}
.bar-label { color: var(--muted); font-size: 0.9rem; }
.bar-track { background: var(--track); border-radius: 999px; height: 8px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; }
.fill-good { background: var(--good); }
.fill-warn { background: var(--warn); }
.fill-bad { background: var(--bad); }
.bar-value {
  font-variant-numeric: tabular-nums;
  font-size: 0.9rem;
  min-width: 4.5rem;
  text-align: right;
}
.bar-value .count { color: var(--muted); font-size: 0.82em; }
.na { color: var(--muted); font-style: italic; }

.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }

table { border-collapse: collapse; width: 100%; min-width: 42rem; font-size: 0.9rem; }
th, td {
  text-align: left;
  padding: 0.55rem 0.7rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
th {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}
tbody tr:last-child td { border-bottom: none; }
td.loc { white-space: nowrap; }
td.loc .mono { overflow-wrap: anywhere; white-space: normal; }
td.msg { min-width: 18rem; }
.rec { color: var(--muted); font-size: 0.92em; display: block; margin-top: 0.3rem; }
.excerpt {
  display: block;
  margin-top: 0.35rem;
  padding: 0.3rem 0.45rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  overflow-wrap: anywhere;
}

.badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.sev-critical { background: var(--bad-bg); color: var(--bad); border: 1px solid var(--bad); }
.sev-error { background: var(--bad-bg); color: var(--bad); }
.sev-warning { background: var(--warn-bg); color: var(--warn); }
.sev-info { background: var(--good-bg); color: var(--good); }

.pill {
  display: inline-block;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.75rem;
}

.empty { text-align: center; padding: 2.5rem 1rem; }
.empty .mark { font-size: 2rem; line-height: 1; }
.empty p { color: var(--muted); margin: 0.5rem 0 0; }

.warnings { margin: 0; padding-left: 1.1rem; color: var(--muted); }
.warnings li { overflow-wrap: anywhere; }

footer { color: var(--muted); font-size: 0.85rem; text-align: center; }
footer p { margin: 0.2rem 0; }

@media (max-width: 560px) {
  body { padding: 1rem 0.75rem 3rem; }
  .card { padding: 1rem; }
  .bar-row { grid-template-columns: minmax(5rem, 7rem) 1fr auto; }
}
`

/** SVG ring gauge. Geometry is precomputed so no script is needed. */
function gauge(score: number): string {
  const radius = 56
  const circumference = 2 * Math.PI * radius
  // Clamped because a malformed result should not produce a negative dash.
  const ratio = Math.min(Math.max(score, 0), 100) / 100
  const filled = circumference * ratio
  const tone = band(score)

  return `<figure class="gauge">
        <svg width="132" height="132" viewBox="0 0 132 132" role="img"
          aria-label="Overall score ${esc(String(score))} out of 100">
          <circle class="track" cx="66" cy="66" r="${radius}" fill="none" stroke-width="12" />
          <circle class="value stroke-${tone}" cx="66" cy="66" r="${radius}" fill="none"
            stroke-width="12" stroke-dasharray="${filled.toFixed(2)} ${circumference.toFixed(2)}" />
        </svg>
        <figcaption>
          <span class="num ${tone}">${esc(String(score))}</span>
          <span class="of">of 100</span>
        </figcaption>
      </figure>`
}

function scoreBars(categories: readonly CategoryScore[]): string {
  if (categories.length === 0) {
    return '<p class="sub">No category scores were produced.</p>'
  }

  const rows = categories
    .map((category) => {
      const label = `<span class="bar-label">${esc(category.category)}</span>`

      if (category.notApplicable) {
        return `<div class="bar-row">${label}
          <div class="bar-track"></div>
          <span class="bar-value na">n/a</span>
        </div>`
      }

      const tone = band(category.score)
      const width = Math.min(Math.max(category.score, 0), 100)
      return `<div class="bar-row">${label}
          <div class="bar-track">
            <div class="bar-fill fill-${tone}" style="width: ${width}%"></div>
          </div>
          <span class="bar-value"><strong class="${tone}">${esc(String(category.score))}</strong>
            <span class="count">${esc(String(category.findingCount))}</span></span>
        </div>`
    })
    .join('\n        ')

  return `<div class="bars">\n        ${rows}\n      </div>`
}

function locationCell(finding: Finding): string {
  if (!finding.file) return '<span class="pill">project</span>'
  const line = finding.location?.line
  // Lines are 1-based, so a reported 0 means "whole file"; showing `:0` would
  // send the reader to a line that does not exist.
  const text = line === undefined || line < 1 ? finding.file : `${finding.file}:${line}`
  return `<span class="mono">${esc(text)}</span>`
}

function impactText(finding: Finding): string | null {
  const impact = finding.estimatedImpact
  if (!impact) return null

  const parts: string[] = []
  if (impact.bytes !== undefined) parts.push(`~${formatBytes(impact.bytes)} smaller`)
  if (impact.startupMs !== undefined) {
    parts.push(`~${formatDuration(impact.startupMs)} faster startup`)
  }
  if (parts.length === 0) return null

  // Presented as an estimate: these come from static analysis, not a real build.
  return `Estimated impact: ${parts.join(', ')}`
}

function findingRow(finding: Finding): string {
  const detail: string[] = []
  if (finding.recommendation) {
    detail.push(`<span class="rec">${esc(finding.recommendation)}</span>`)
  }
  if (finding.excerpt) {
    detail.push(`<code class="excerpt">${esc(truncate(finding.excerpt))}</code>`)
  }
  const impact = impactText(finding)
  if (impact) detail.push(`<span class="rec">${esc(impact)}</span>`)
  if (finding.fixable) detail.push('<span class="rec">Auto-fixable.</span>')

  const badge = `<span class="badge sev-${esc(finding.severity)}">${esc(finding.severity)}</span>`

  return `<tr>
            <td>${badge}</td>
            <td><code>${esc(finding.ruleId)}</code></td>
            <td class="loc">${locationCell(finding)}</td>
            <td class="msg">${esc(finding.message)}${detail.join('')}</td>
          </tr>`
}

function bySeverityDesc(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    a.ruleId.localeCompare(b.ruleId) ||
    (a.file ?? '').localeCompare(b.file ?? '')
  )
}

function categoryCard(category: string, findings: readonly Finding[]): string {
  const rows = [...findings].sort(bySeverityDesc).map(findingRow).join('\n')
  const count = `<span class="pill">${esc(pluralize(findings.length, 'finding'))}</span>`

  return `<section class="card">
      <h2>${esc(category)} ${count}</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Severity</th><th>Rule</th><th>Location</th><th>Message</th></tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>
    </section>`
}

function severityTally(findings: readonly Finding[]): string {
  const counts = new Map<Severity, number>()
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1)
  }

  // Highest severity first, and only severities actually present.
  const order: Severity[] = ['critical', 'error', 'warning', 'info']
  const pills = order
    .filter((severity) => (counts.get(severity) ?? 0) > 0)
    .map((severity) => {
      const count = counts.get(severity) ?? 0
      return `<span class="badge sev-${severity}">${esc(`${count} ${severity}`)}</span>`
    })

  return pills.length === 0 ? '' : `<p class="sub">${pills.join(' ')}</p>`
}

/** Self-contained single-file HTML report. Works offline from a `file://` URL. */
export const htmlReporter: Reporter = {
  format: 'html',
  extension: 'html',
  render(result: AnalysisResult): string {
    const { findings, score, metrics } = result

    const header = `<header class="card">
      ${gauge(score.overall)}
      <div class="titles">
        <h1>ExpoPulse Report</h1>
        <p class="sub">${esc(result.root)}</p>
        <p class="sub">${esc(pluralize(findings.length, 'finding'))} &middot;
          ${esc(result.timestamp)}</p>
        ${severityTally(findings)}
      </div>
    </header>`

    const scores = `<section class="card">
      <h2>Category scores</h2>
      ${scoreBars(score.categories)}
    </section>`

    let body: string
    if (findings.length === 0) {
      body = `<section class="card empty">
      <div class="mark ${band(score.overall)}">&#10003;</div>
      <h2>No findings</h2>
      <p>Every enabled rule passed.</p>
    </section>`
    } else {
      const byCategory = groupBy(findings, (finding) => finding.category)
      // Driven off the score list so card order matches the bars above.
      body = score.categories
        .map((category) => {
          const group = byCategory[category.category]
          if (!group || group.length === 0) return null
          return categoryCard(category.category, group)
        })
        .filter((card): card is string => card !== null)
        .join('\n    ')
    }

    const warnings =
      result.warnings.length === 0
        ? ''
        : `<section class="card">
      <h2>Analysis warnings</h2>
      <ul class="warnings">
        ${result.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('\n        ')}
      </ul>
    </section>`

    const footer = `<footer>
      <p>${esc(
        `Analyzed ${pluralize(metrics.filesAnalyzed, 'file')} and ` +
          `${pluralize(metrics.assetsAnalyzed, 'asset')} against ` +
          `${pluralize(metrics.rulesRun, 'rule')} in ${formatDuration(metrics.durationMs)}.`,
      )}</p>
      <p>ExpoPulse v${esc(result.toolVersion)}</p>
    </footer>`

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ExpoPulse Report</title>
<style>${STYLES}</style>
</head>
<body>
  <main>
    ${header}
    ${scores}
    ${body}
    ${warnings}
    ${footer}
  </main>
</body>
</html>
`
  },
}
