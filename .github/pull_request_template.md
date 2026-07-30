<!--
Thanks for contributing. Delete any section that does not apply.
See CONTRIBUTING.md for the conventions this project follows.
-->

## What

<!-- What does this change do? One or two sentences. -->

## Why

<!--
What problem does it solve? Link the issue if there is one (`Closes #123`).
If there is no issue, explain the situation that prompted the change.
-->

## Type of change

- [ ] Bug fix
- [ ] New rule
- [ ] New fixer
- [ ] New report format
- [ ] CLI change (new command, flag, or output change)
- [ ] `@expopulse/core` API change
- [ ] Documentation
- [ ] Internal refactor, tests or tooling

## Verification

- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm build` succeeds
- [ ] Tried against a real Expo project, not only `examples/demo-app`
- [ ] Added or updated tests covering the change
- [ ] Added a `CHANGELOG.md` entry under `## [Unreleased]` (for anything user-visible)

<!-- Which real project, and what did you see? -->

## Breaking changes

<!--
The project is pre-1.0, but breaking changes still need calling out so they can
be documented. Renaming a rule id, changing a default severity, changing a CLI
flag, or changing anything in `shared/types.ts` counts. Write "None" if none.
-->

---

## For new rules and fixers

<!-- Delete this whole section if the PR adds neither. -->

### Rule id and category

<!-- e.g. `assets/oversized-image`, category `assets`. -->

### Severity rationale

<!--
Which default severity, and why that one rather than the level above or below?
`critical` — the app is broken or will be rejected.
`error` — it will ship and misbehave.
`warning` — it costs size, memory or maintainability.
`info` — a suggestion a developer may reasonably decline.

`error` and `critical` fail CI builds by default, so justify those specifically.
Note the scoring weights too: penalties are 1 / 4 / 12 / 25 with diminishing
returns after five occurrences of the same rule, so a rule that fires on every
file at `warning` will dominate its category's score.
-->

### False-positive risk

<!--
When is the flagged pattern deliberate and correct? What does the rule do about
it — does it narrow the check, soften the message, or state the caveat on every
finding? "It cannot be wrong" is almost never the right answer and will be
questioned in review.
-->

### Estimated impact

<!--
If the rule reports `estimatedImpact`, how was the figure derived and what does
it assume? Every estimate needs a `note` that says so.
-->

### Fixer safety

<!-- Only for PRs adding or changing a fixer. -->

- [ ] `plan` is side-effect free — `--dry-run` and the preview show exactly what applying does
- [ ] Every write and delete resolves through `resolveWithinRoot`, and `null` skips the action
- [ ] `apply` re-checks its assumptions rather than trusting a possibly-stale plan
- [ ] The fix cannot make a file worse (larger, reformatted, or partially rewritten)
- [ ] Anything ambiguous is skipped rather than guessed at
- [ ] `safe: false` if it changes a file's name, extension or public shape
- [ ] Checked interaction with other fixers targeting the same files (`reconcilePlans`)
- [ ] Action `description` text is accurate — it is what users read before agreeing

<!-- Describe what the fixer writes, what it deletes, and what happens on rollback. -->
