# ExpoPulse

**Rule-based static analysis and optimisation platform for Expo applications.**

[![CI](https://github.com/sourav2024/expopulse/actions/workflows/ci.yml/badge.svg)](https://github.com/sourav2024/expopulse/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/expopulse.svg)](https://www.npmjs.com/package/expopulse)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-ff69b4.svg)](https://github.com/sponsors/sourav2024)

ExpoPulse analyses an Expo project across code, assets, dependencies, configuration
and native platform layers. It does not just report problems: it explains them,
estimates their impact, recommends fixes, and applies the safe ones for you.

```bash
npx expopulse analyze
```

No configuration needed to start. No API keys, no account, no telemetry — every
check runs locally against files already on disk.

> **Status: 0.x.** Rule IDs and CLI flags may still change before 1.0; see the
> [versioning strategy](CHANGELOG.md#versioning-strategy). Pin an exact version if
> you gate CI on the score.

## Requirements

| Requirement         | Version | Notes                                             |
| ------------------- | ------- | ------------------------------------------------- |
| **Node.js**         | >= 20   | Check with `node --version`                       |
| **An Expo project** | any     | Reads `app.json`, `package.json`, and native dirs |

## Install

Run it without installing:

```bash
npx expopulse analyze
```

Or add it to a project so the version is pinned in your lockfile:

```bash
npm install --save-dev expopulse
npx expopulse analyze
```

Or install it globally:

```bash
npm install -g expopulse
expopulse analyze
```

## Commands

| Command | Purpose |
| --- | --- |
| `expopulse analyze` | Analyse the project and report findings (default command) |
| `expopulse doctor` | Check the environment and project setup |
| `expopulse fix` | Apply safe automatic fixes, with preview and rollback |
| `expopulse compare` | Diff the project against a saved baseline |
| `expopulse report` | Generate HTML, Markdown, JSON or SARIF reports |

### analyze

```bash
expopulse analyze                        # terminal report
expopulse analyze --verbose              # include rationale and recommendations
expopulse analyze --only expo,android    # restrict to specific layers
expopulse analyze --json                 # machine-readable output on stdout
expopulse analyze --format html,sarif    # write file reports
expopulse analyze --fail-on error        # exit 1 if any error-level finding exists
expopulse analyze --min-score 85         # exit 1 if the score is below 85
```

Exit codes: `0` clean, `1` findings tripped the configured threshold, `2` the tool
itself failed. CI can therefore distinguish "your project has issues" from
"ExpoPulse broke".

### fix

Every fix is previewed before anything is written, and every modified file is
backed up first.

```bash
expopulse fix --dry-run                  # preview only, never writes
expopulse fix                            # preview, then prompt
expopulse fix --yes                      # skip the prompt (CI)
expopulse fix --rule assets/unused-asset # fix one rule only
expopulse fix --list-backups
expopulse fix --rollback <id>            # restore a previous run exactly
```

Unsafe fixes are never applied automatically. WebP conversion changes file
extensions, so it stays behind `--webp` and leaves import updates to you.

### compare

```bash
expopulse compare --save baseline.json      # record the current state
expopulse compare --baseline baseline.json  # diff against it
```

## Use with coding agents

ExpoPulse ships an Agent Skill that teaches Claude Code, Codex and other coding
agents to use the CLI the way a senior React Native engineer would:

- triage release blockers before size wins
- verify "unused" findings before deleting anything
- fix one approved rule at a time, with rollback

```bash
npx skills add sourav2024/expopulse          # any agent, via skills.sh
```

In Claude Code you can also install it as a plugin:
`/plugin marketplace add sourav2024/expopulse`, then
`/plugin install expopulse@expopulse`.

Then ask: *"Is this Expo app ready for the Play Store?"* or *"Why is our app
download so big?"* The skill lives in [skills/expopulse](skills/expopulse).

## Analysis layers

| Layer | Covers |
| --- | --- |
| Code | React/React Native anti-patterns, unused imports, list performance, render-time work |
| Assets | Unused and duplicate assets, oversized images, fonts, dimensions |
| Dependencies | Unused, missing, deprecated and heavyweight packages, lighter alternatives |
| Expo | SDK compatibility, Hermes, OTA runtime version, icons, plugins, EAS profiles |
| Android | Manifest permissions, target SDK, R8/minification, cleartext traffic, ABI splits |
| iOS | Info.plist usage descriptions, privacy manifest, ATS, background modes |

Layers that do not apply are skipped, not failed. A managed-workflow project with
no `android/` directory is not penalised for Android findings it cannot have.

Run `expopulse doctor --rules` to list every rule.

## Configuration

Optional. ExpoPulse works with zero configuration.

Create `expopulse.config.ts` (or `.js`, `.mjs`, `.expopulserc.json`, or an
`expopulse` key in `package.json`):

```ts
import { defineConfig } from '@expopulse/core'

export default defineConfig({
  ignore: ['**/generated/**'],
  rules: {
    'react/no-inline-style': 'warning',
    'assets/duplicate-image': 'error',
    'bundle/large-image': 'off',
  },
  thresholds: {
    maxImageBytes: 500 * 1024,
    minScore: 80,
  },
  report: {
    formats: ['cli', 'html'],
    outDir: '.expopulse/reports',
  },
  ci: {
    failOn: 'error',
    enforceScore: true,
  },
})
```

TypeScript config files require Node 22.6+ (with `--experimental-strip-types`) or
Node 23.6+. Use `.mjs` or `.json` on older runtimes.

Rule levels are `info`, `warning`, `error`, `critical`, or `off`.

## Reports

- **CLI** — colourised terminal output with scores and grouped findings
- **HTML** — self-contained single file, light and dark themes, works offline
- **Markdown** — for pull request comments and documentation
- **JSON** — the full result object, and the input format for `compare`
- **SARIF** — 2.1.0, for GitHub code scanning

## Continuous integration

```yaml
- run: npx expopulse analyze --format sarif --fail-on error
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: .expopulse/reports/expopulse-report.sarif
```

## Packages

| Package                                                                    | Description                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`expopulse`](https://www.npmjs.com/package/expopulse) ([src](apps/cli))    | The CLI                                                                               |
| [`@expopulse/core`](https://www.npmjs.com/package/@expopulse/core) ([src](packages/core)) | Engine, rules, fixers and reporters — for plugins, editor integrations and CI tooling |

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

Biome's `style/useTemplate` rule is disabled in [biome.json](biome.json): user-facing
messages are assembled by concatenating short template literals across lines to stay
within the 100-column limit, and collapsing them into single literals would make
those lines unreadable. Other relaxed rules are set to `warn`, not `off`.

Try it against the bundled fixture, which contains deliberate problems:

```bash
cd examples/demo-app
node ../../apps/cli/dist/index.js analyze
```

## Known limitations

These are real constraints in 0.x, not oversights:

- **Dynamic `app.config.ts` is not evaluated.** Expo configs can read
  environment variables, so static analysis cannot resolve them safely. When one
  is present ExpoPulse analyses `app.json` and says so in its warnings.
- **Reference detection is textual.** An asset or dependency referenced only
  through a computed path may be reported as unused. Verify before deleting.
- **Dependency sizes are unreliable under pnpm.** pnpm links packages rather than
  copying them, so `deps/large-dependency` under-reports on pnpm projects.
- **The Expo SDK compatibility table is hand-maintained** and drives
  error-severity rules. Unknown or newer SDKs are treated as fine rather than
  flagged. Verify version-mismatch findings against the official changelog.
- **Native parsers are deliberately shallow.** `AndroidManifest.xml`, Gradle
  files and `Info.plist` are read with targeted extractors, not full parsers.
  Unusual formatting yields no findings rather than wrong ones.
- **Bundle layer is not implemented.** The `bundle` category is reserved and
  always reports as not applicable.
- **Estimated impact is an estimate.** Figures come from static analysis, never
  from a real build.

## Contributing

Contributions are welcome — new rules and false-positive fixes especially.
Start with [CONTRIBUTING.md](CONTRIBUTING.md), which covers the monorepo layout,
how to add a rule or a fixer, and what makes a good one.

```bash
git clone https://github.com/sourav2024/expopulse
cd expopulse
pnpm install
pnpm build && pnpm test
```

- [Report a bug](https://github.com/sourav2024/expopulse/issues/new?template=bug_report.yml)
- [Request a rule or feature](https://github.com/sourav2024/expopulse/issues/new?template=feature_request.yml)
- [Ask a question](https://github.com/sourav2024/expopulse/discussions)
- [Get help](SUPPORT.md)

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

`expopulse fix` **writes to your source files**, deletes assets, and can restore
from an on-disk backup manifest. Every modified file is backed up first, fixer
paths are constrained to the project root, and the scanner does not follow
symlinks out of the project. Even so, commit your work before running `fix`.

Full threat model and reporting process: [SECURITY.md](SECURITY.md). Please report
vulnerabilities [privately](https://github.com/sourav2024/expopulse/security/advisories/new)
rather than in a public issue.

## Support this project

ExpoPulse is free and MIT-licensed, and it stays that way. If it caught a Play
Store rejection before you shipped, you can
[sponsor the work on GitHub](https://github.com/sponsors/sourav2024).

Starring the repo, filing a good bug report, or telling me which rule produced a
false positive on your project helps just as much and costs nothing.

## Licence

MIT © [sourav2024](https://github.com/sourav2024)

## Design notes

Architecture diagram, request flow, design trade-offs and known limitations: [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md).
