# @expopulse/core

Analysis engine, rules, fixers and reporters for [ExpoPulse](https://github.com/truxo/expopulse).

This is the programmatic API. If you want the command-line tool, install
[`expopulse`](https://www.npmjs.com/package/expopulse) instead.

Use this package to embed ExpoPulse in an editor extension, a CI service, or a
custom tool, or to write a plugin — it carries the engine without the CLI's
terminal-presentation dependencies.

```bash
npm install @expopulse/core
```

Requires Node.js 20 or newer.

## Programmatic analysis

```ts
import { allAnalyzers, analyze, createLogger, loadConfig } from '@expopulse/core'

const config = await loadConfig(process.cwd())
const result = await analyze({
  config,
  logger: createLogger('info'),
  analyzers: allAnalyzers,
})

console.log(result.score.overall) // 0-100
for (const finding of result.findings) {
  console.log(finding.severity, finding.ruleId, finding.file, finding.message)
}
```

## Rendering reports

```ts
import { renderReport } from '@expopulse/core'

const html = renderReport(result, 'html')     // self-contained single file
const sarif = renderReport(result, 'sarif')   // SARIF 2.1.0
```

The `cli` format is provided by the `expopulse` package, which owns the terminal
presentation dependencies.

## Applying fixes

```ts
import { planFixes, runFixes, scanProject } from '@expopulse/core'

const { project } = await scanProject(config, logger)

// Planning never touches the filesystem, so previews are exact.
const { plans } = await planFixes({ result, project, config, logger })

// Applying backs up every modified file and returns a rollback id.
const summary = await runFixes({ result, project, config, logger })
```

## Writing a plugin

```ts
import type { Plugin, Rule } from '@expopulse/core'

const noTodoComments: Rule<unknown> = {
  meta: {
    id: 'my-plugin/no-todo',
    category: 'code',
    severity: 'info',
    description: 'Flags TODO comments',
  },
  check() {
    return [] // return FindingDraft[]; the engine stamps rule identity
  },
}

export default {
  name: 'my-plugin',
  rules: () => [noTodoComments],
} satisfies Plugin
```

Rules return `FindingDraft[]` and must not write to the filesystem — writing is the
fix engine's job. The engine fills in `ruleId`, `category` and `severity` from
`meta`, so a rule cannot misattribute its own findings.

## Stability

This package is pre-1.0. The types in `shared/types.ts` are the public contract
plugin authors bind to; treat changes there as breaking. Everything reachable from
the package root is public API — nothing else is.

## Licence

MIT
