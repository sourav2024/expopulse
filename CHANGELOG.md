# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both published packages, `expopulse` and `@expopulse/core`, are versioned and
released together.

## [Unreleased]

## [0.1.0] - 2026-07-30

Initial release.

### Added

- **Five commands.**
  - `analyze` (aliased `analyse`, and the default command) — analyses the project
    and reports findings. Supports `--only` to restrict categories, `--verbose`
    for rationale and recommendations, `--json` for stdout, `--format` for file
    reports, and `--fail-on` / `--min-score` for CI gating. Exit codes separate
    "your project has issues" (`1`) from "ExpoPulse broke" (`2`).
  - `doctor` — checks the environment and project setup; `--rules` lists every
    available rule.
  - `fix` — applies safe automatic fixes, with `--dry-run`, `--yes`, `--rule`,
    `--webp`, `--no-backup`, `--list-backups` and `--rollback`.
  - `compare` — diffs the project against a saved baseline, with `--save`,
    `--baseline` and `--against`.
  - `report` — generates reports in one or more formats, optionally `--from` a
    saved JSON report.
- **Analysis across eight categories** — `code`, `assets`, `dependencies`,
  `expo`, `android`, `ios`, `performance` and `bundle` — produced by six
  analyzers. A layer that does not apply to a project is skipped and marked not
  applicable rather than failed, so a managed-workflow project is not penalised
  for Android findings it cannot have. The `bundle` category is reserved and has
  no rules in this release.
- **Scoring.** Per-category scores out of 100 and a weighted overall score.
  Penalties are non-linear by severity (`info` 1, `warning` 4, `error` 12,
  `critical` 25) with diminishing returns after the first five occurrences of the
  same rule, so one noisy rule cannot flatten a category's score to zero and stop
  it conveying information. Categories that did not run are excluded from the
  overall score.
- **Fix engine** with planning separated from application, so `--dry-run` and the
  interactive preview show exactly what applying would do. Every file a fix
  touches is backed up into a timestamped session under `.expopulse/backups/`
  first; a failed backup skips the plan rather than making an unrecoverable edit,
  and a fixer that throws rolls the whole session back. `--rollback <id>` restores
  a previous run. Conflicting plans are reconciled so two rules cannot between
  them delete every copy of an asset. Unsafe fixes are never applied
  automatically — WebP conversion changes file extensions and stays behind
  `--webp`.
- **Report formats:** `cli` (colourised terminal output with scores and grouped
  findings), `json` (the full result object, and the input format for `compare`),
  `markdown` (for pull request comments), `html` (self-contained single file,
  light and dark themes, works offline) and `sarif` (2.1.0, for GitHub code
  scanning).
- **Baseline compare.** `compare --save` records the current state; `compare
  --baseline` diffs against it, reporting added, removed and unchanged findings,
  the score delta per category, and the change in estimated recoverable bytes.
- **Zero-config operation** with optional configuration via
  `expopulse.config.ts` / `.js` / `.mjs`, `.expopulserc.json`, or an `expopulse`
  key in `package.json`. Supports per-rule severity overrides, ignore and include
  globs, thresholds, report settings, CI behaviour, caching and plugins.
- **`@expopulse/core`** published as a separate package so editor integrations,
  CI tooling and plugins can use the engine without the CLI.

### Known limitations

Documented in full in the README. In short: dynamic `app.config.ts` is not
evaluated; reference detection is textual and can report a dynamically-loaded
asset as unused; dependency sizes under-report on pnpm; the Expo SDK
compatibility table is hand-maintained; native manifest parsers are deliberately
shallow; the `bundle` category is not implemented; and estimated impact figures
come from static analysis, never from a real build.

## Versioning strategy

### Below 1.0

This is an early release and the API is not settled. While the version is `0.x`,
expect the following to change in **minor** releases, with the change documented
here:

- **Rule ids.** Rules may be renamed, split, merged or removed. If you pin rule
  ids in `expopulse.config.ts` or in CI gates, read the changelog before
  upgrading.
- **Default severities.** A rule's default level may move up or down as its
  false-positive rate becomes clearer in real projects. This can change your
  score and, with `--fail-on`, whether your build passes.
- **CLI flags.** Flag names, defaults and output shapes may change.
- **The `@expopulse/core` API**, including the types in `shared/types.ts` that
  plugins bind to.
- **Scoring.** Penalties, weights and the damping curve may be retuned, which
  changes scores without any change to your project.

Patch releases below 1.0 are reserved for bug fixes, including fixes to false
positives that make an existing rule fire less often.

If you need reproducible results in CI today, pin an exact version rather than a
range, and store a baseline with `compare --save`.

### After 1.0

Standard semantic versioning, with these specifics:

- **Major** — removing or renaming a rule id; removing or renaming a CLI flag or
  command; a breaking change to the `@expopulse/core` public API or to the
  `AnalysisResult` schema; changing a rule's default severity upwards in a way
  that fails builds that previously passed; changing the meaning of an exit code.
- **Minor** — new rules, new fixers, new report formats, new commands and new
  flags; new optional config fields. A new rule can lower your score and, at
  `error` or above, fail a build that previously passed — new rules will
  therefore be introduced at a conservative severity and announced here.
- **Patch** — bug fixes, false-positive fixes, corrections to the SDK
  compatibility table, message and documentation wording, and performance work
  that does not change findings.

Scoring changes after 1.0 will be treated as breaking, since they change CI
outcomes for unchanged projects.

[Unreleased]: https://github.com/sourav2024/expopulse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sourav2024/expopulse/releases/tag/v0.1.0
