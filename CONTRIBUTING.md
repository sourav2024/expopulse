# Contributing to ExpoPulse

Thanks for taking the time. This document covers how to get the repository
running, how the monorepo fits together, and the two contributions that come up
most often: adding a rule and adding a fixer.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). If you
have found a security problem, do not open an issue — follow
[SECURITY.md](SECURITY.md) instead.

## Quick start

Node 20 or newer, and pnpm 11.4.0 (the version pinned in `packageManager`).

```bash
pnpm install
pnpm build       # tsup, both packages
pnpm test        # vitest, 45 tests
pnpm lint        # biome check .
pnpm typecheck   # tsc --noEmit, both packages
```

`pnpm lint:fix` and `pnpm format` apply Biome's fixes. `pnpm dev` runs both
packages' `tsup --watch` in parallel.

Run the built CLI against the bundled fixture, which contains deliberate
problems, to see a change end to end:

```bash
cd examples/demo-app
node ../../apps/cli/dist/index.js analyze --verbose
node ../../apps/cli/dist/index.js fix --dry-run
```

CI runs lint, typecheck, build, test, and then the same three fixture commands
against the built binary. Getting those five green locally is the whole bar.

## Monorepo layout

pnpm workspaces, two publishable packages plus a fixture.

```
packages/core   @expopulse/core — the engine. All analysis, rules, fixers,
                reporters, config loading and scoring live here.
apps/cli        expopulse — the CLI. Commander wiring, terminal rendering,
                exit codes. Contains no analysis logic.
examples/       demo-app fixture and a sample config.
tests/          Vitest suites. They exercise core through its public API.
```

The split is deliberate: `@expopulse/core` is the API that editor integrations,
CI tooling and plugins bind to, so anything that would be useful without a
terminal belongs there. If you find yourself importing `chalk` into core, or
writing a rule inside `apps/cli`, the code is in the wrong package.

Inside `packages/core/src`:

```
core/        engine, scanner, rules-engine, scoring, compare, impact
analyzers/   one directory per layer: code, assets, deps, expo, android, ios
fixers/      fix-engine, backup, safe-path, and the fixers themselves
reporters/   json, markdown, html, sarif
config/      defaults and cosmiconfig loading
shared/      types, logger, utils
```

`shared/types.ts` is the public contract. Changes there are semver-relevant even
below 1.0 — say so in your PR.

### Analysis layers and categories

There are six analyzers (`code`, `assets`, `deps`, `expo`, `android`, `ios`) but
eight categories (`code`, `assets`, `dependencies`, `expo`, `android`, `ios`,
`bundle`, `performance`). An analyzer may emit findings in a category other than
its own — the code analyzer contributes `performance` findings, for example, and
the engine registers every category its enabled rules can report so those
findings are not silently dropped from scoring. The `bundle` category is
reserved and has no rules today.

## Adding a rule

Rules live in `packages/core/src/analyzers/<layer>/rules.ts`. Read
`analyzers/assets/rules.ts` first; it is the most representative example.

A rule is a plain object with `meta` and a `check` function:

```ts
const unusedFont: Rule<AssetModel> = {
  meta: {
    id: 'assets/unused-font',
    category: 'assets',
    severity: 'warning',
    description: 'Font file name never appears in source code or app.json',
    rationale:
      'Font families are commonly added as a full weight set but only two or three weights are ' +
      'ever loaded. The rest ship unused, at a few hundred KB each.',
    recommendation: 'Remove weights the app never loads via useFonts or expo-font.',
    fixable: true,
  },

  check(model: AssetModel): FindingDraft[] {
    // ...
  },
}
```

The rules to follow:

- **The id is `layer/kebab-case-problem`** and it is a user-facing identifier.
  People put rule ids in config files and CI gates. Choose carefully; renaming
  one is a breaking change.
- **`check` returns `FindingDraft[]`, not `Finding[]`.** The engine stamps
  `ruleId`, `category` and `severity` from `meta`. Only describe what is specific
  to each occurrence. A draft may override `severity` for a particular
  occurrence when that occurrence is genuinely worse than the rule's default.
- **`check` must not touch the filesystem.** It receives an already-collected
  model and a `RuleContext` (`project`, `config`, `logger`). Reading files is the
  analyzer's `collect` step; writing is the fix engine's job. `check` may be
  async, but only for computation.
- **`rationale` explains why it matters; `recommendation` says what to do.** Put
  the general case in `meta` and the occurrence-specific case on the draft. When
  a rule's detection is heuristic, repeat the caveat on every finding rather than
  only in `meta.rationale` — `assets/rules.ts` does this with
  `REFERENCE_HEURISTIC` because the suggested action is deletion and the user
  needs the caveat at the point of decision.
- **`estimatedImpact` is an estimate and must read like one.** Include a `note`
  saying how the number was derived and what it assumes. If you cannot estimate
  the bytes honestly, omit `bytes` and give a `note` explaining why.
- **`data` carries the payload a fixer will need.** It is passed through to the
  fixer untouched, so put the concrete paths and values there rather than making
  the fixer re-derive them from the message.
- **Set `fixable: true` only when a fixer actually exists** for that rule id.
  The fix engine reports fixable findings with no registered fixer as unhandled.

Export the rule from the layer's `rules.ts` array. `allRules()` in
`analyzers/index.ts` picks it up automatically, so `expopulse doctor --rules`
lists it with no further wiring.

Then:

- Add a test in `tests/`. Regression tests belong in `tests/regressions.test.ts`.
- Consider adding the problem to `examples/demo-app` so the fixture exercises it
  and the CI smoke test covers the rule end to end.
- Choose the default severity conservatively. `error` and `critical` fail CI
  builds by default. A rule that is right 90% of the time should be `warning` or
  `info`, not `error`.

### Choosing a severity

The scoring penalties are `info` 1, `warning` 4, `error` 12, `critical` 25, with
diminishing returns after the first five occurrences of the same rule. A rule
that fires hundreds of times on a normal project at `warning` will dominate its
category's score, so noisy rules should be `info`.

Rough guide: `critical` means the app is broken or will be rejected; `error`
means it will ship and misbehave; `warning` means it costs size, memory or
maintainability; `info` is a suggestion the developer may reasonably decline.

## Adding a fixer

Fixers live in `packages/core/src/fixers/` and are registered in
`builtinFixers` in `fix-engine.ts`. **Fixers write to users' source files and
delete their assets.** Everything below follows from that.

The interface is two methods:

```ts
export interface Fixer {
  ruleId: string
  safe: boolean
  plan(findings: Finding[], ctx: FixContext): Promise<FixPlan>
  apply(plan: FixPlan, ctx: FixContext): Promise<FixResult>
}
```

Hard requirements:

- **`plan` must be side-effect free.** The engine always calls `plan` first, and
  `--dry-run` and the interactive preview render its output. If planning writes,
  `--dry-run` lies.
- **Every path must go through `resolveWithinRoot`** from `fixers/safe-path.ts`
  before you write to it or delete it, and `null` means *skip this action*, never
  *use the raw path*. Paths reach fixers from rule `data` (which a third-party
  plugin can populate) and from the on-disk backup manifest. A `../` segment
  otherwise lets a fix delete files anywhere the process can reach.
- **Do not assume a backup exists — but rely on the engine to make one.** The
  engine backs up every file in the plan before calling `apply`, and a backup
  that fails is fatal for that plan rather than a warning: applying anyway would
  make the edit unrecoverable while the summary still advertises `--rollback`.
  Users can pass `--no-backup`, so a fixer that is destructive without a backup
  should say so in its action `description`.
- **Re-check between plan and apply.** The file may have changed. `apply` should
  verify its assumption still holds and push to `result.failed` rather than
  proceeding on stale state. `compressImageFixer` re-stats the file and refuses
  to write when recompression no longer saves bytes.
- **Never make things worse silently.** A "safe fix" that inflates an
  already-optimised image, or reformats a whole file to change one line, is worse
  than no fix. `removeUnusedImportFixer` is line-oriented for exactly this
  reason: reprinting through Babel would reformat everything the user's formatter
  owns and turn a one-line fix into an unreviewable diff.
- **Skip what you cannot rewrite confidently.** Guessing is not an option when
  the output overwrites the user's source. `removeSpecifiers` returns `null` for
  multi-line imports, namespace imports it cannot fully remove, and lines holding
  more than one statement.
- **`safe: false` for anything that changes a file's name, extension or public
  shape.** Unsafe fixers do not run unless the user opts in explicitly;
  `convertToWebpFixer` is gated behind `fix.convertToWebp` / `--webp` because it
  changes the extension and every import of the file.

Report `FixAction`s with an honest `description` — it is what the user reads in
the preview before agreeing — and accurate `bytesSaved`, since the summary and
`compare` add them up.

If two fixers can target the same file, check `reconcilePlans` in
`fix-engine.ts`. It drops modifications to files another plan is deleting and
lets only the first plan claim a deletion, which is what stops the unused-asset
and duplicate-image fixers between them deleting every copy of an asset.

## Code style

Biome handles formatting and linting; run `pnpm lint:fix` before pushing. Single
quotes, no semicolons, trailing commas, two-space indent, 100 columns.

`style/useTemplate` is disabled in `biome.json` on purpose: user-facing messages
are assembled by concatenating short template literals across lines to stay
within the column limit, and collapsing them into single literals would make
those lines unreadable. Other relaxed rules are `warn`, not `off` — do not add
`off` without explaining why in the PR.

On comments: **explain why, not what.** The code already says what it does. A
comment earns its place when it records a decision, a constraint, or a trap —
why `followSymbolicLinks: false` is load-bearing rather than a performance tweak,
why the duplicate fixer must never fall back to `data.duplicates`, why the import
fixer preserves CRLF. Comments that restate the next line will be asked about in
review.

Spelling follows British conventions in user-facing text and prose ("analyse",
"optimisation", "colourised"), matching the README. Identifiers stay as they are
— `analyzers/`, `Analyzer`, and the `analyze` command are American by
convention and by npm; `analyse` exists as a CLI alias.

## Pull requests

1. Open an issue first for anything larger than a bug fix, so the design can be
   agreed before you write it. New rules especially: the default severity and the
   false-positive rate are the parts worth discussing.
2. Branch from `main`.
3. Keep the change focused. A new rule, its test and its fixture entry is one PR;
   a new rule plus a refactor of the scanner is two.
4. Make `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` pass, and try
   the change against a real Expo project, not only the fixture.
5. Fill in the PR template. For rules and fixers, the severity rationale and the
   false-positive risk sections are the ones that get read most carefully.
6. Add a `CHANGELOG.md` entry under `## [Unreleased]` for anything user-visible.

Expect review comments about false positives, about severity, and about whether
a fix is genuinely safe. Those are the three things that determine whether people
can trust the tool, so they get disproportionate attention.

## Releasing

For maintainers.

`apps/cli` depends on `"@expopulse/core": "workspace:*"`. Only `pnpm publish`
rewrites that protocol to a real version range — `npm publish` would ship the
literal `workspace:*` string, which no registry can resolve, and every install
of `expopulse` would fail.

So:

- Publish with `pnpm publish`, never `npm publish`.
- Publish `@expopulse/core` **first**, then `expopulse`. The rewritten dependency
  points at a core version that must already exist on the registry.
- Verify with `npm pack` (or `pnpm publish --dry-run`) that the tarball's
  `package.json` contains a real version range before pushing the tag.

## Questions

See [SUPPORT.md](SUPPORT.md).
