# Support

ExpoPulse is maintained by one person. Response times are best effort, and a
well-formed report gets answered a lot faster than a vague one.

## Where to go

| You want to | Go to |
| --- | --- |
| Ask a question, or check whether a finding is correct | [Discussions](https://github.com/sourav2024/expopulse/discussions) |
| Report a bug or a false positive | [New issue](https://github.com/sourav2024/expopulse/issues/new/choose) |
| Suggest a rule, fixer or feature | [New issue](https://github.com/sourav2024/expopulse/issues/new/choose) |
| Report a security vulnerability | [Private advisory](https://github.com/sourav2024/expopulse/security/advisories/new) — **not** an issue. See [SECURITY.md](SECURITY.md) |
| Contribute code | [CONTRIBUTING.md](CONTRIBUTING.md) |

Before opening anything, check the **Known limitations** section of the
[README](README.md#known-limitations). Several of the most common reports are
documented constraints rather than bugs — textual reference detection producing
false "unused" findings, unreliable dependency sizes under pnpm, dynamic
`app.config.ts` not being evaluated, and the `bundle` category always reporting
as not applicable.

Also search existing issues and Discussions. Duplicates get closed with a link.

## Filing a good bug report

The [bug report form](https://github.com/sourav2024/expopulse/issues/new/choose)
asks for the following. All of it is load-bearing.

- **The ExpoPulse version** — `expopulse --version`.
- **Your Node version** — `node --version`. ExpoPulse needs Node 20 or newer;
  TypeScript config files need Node 22.6+ or 23.6+.
- **Your OS**, including whether you are on CI. Several past bugs were
  platform-specific (line endings on Windows, file descriptor limits on macOS,
  `sharp` failing to link).
- **The analyze output.** `expopulse analyze --json` is the most useful form,
  since it includes the tool version, the metrics, the warnings array and every
  finding verbatim. If that is too large or too revealing, paste the terminal
  output from `expopulse analyze --verbose` and the relevant findings.
- **The exact command you ran**, with its flags.

Redact paths and names if you need to, but say that you have — a report where
`assets/logo.png` has been renamed reads very differently once we know.

### False positives

If a rule fired on something that is actually fine, that is a bug and worth
reporting. Include:

- The **rule id** exactly as it appears in the output, e.g. `assets/unused-asset`.
- The code, asset or config the rule flagged.
- Why it is correct as written — particularly how the thing is referenced, if the
  rule claims it is unused.

A minimal reproduction beats a description. If you can trigger it in a fresh
`npx create-expo-app` project, say so and include the diff.

### If `fix` was involved

Say so prominently. `fix` writes to real files, so a bug there is more serious
than a bad report and gets triaged first. Include:

- Whether you ran with `--dry-run`, `--yes`, `--webp`, `--rule`, or `--no-backup`.
- What the preview said it would do, and what it actually did.
- Whether `--rollback` recovered the files.

If a fix damaged or deleted something it should not have, restore from git or
from `.expopulse/backups/`, then report it. Do not keep running `fix` on the
same tree while investigating.

## Working around a problem

While you wait:

- Turn a noisy rule down or off in `expopulse.config.ts`:
  `rules: { 'assets/unused-asset': 'off' }`. Levels are `info`, `warning`,
  `error`, `critical`, `off`.
- Restrict a run to the layers you trust: `expopulse analyze --only expo,android`.
- Exclude paths with `ignore: ['**/generated/**']`.
- Run `expopulse doctor` to check your environment, and `expopulse doctor --rules`
  to list every rule and its id.
- Use `--debug` for stack traces when the tool itself fails. Exit code `2` means
  ExpoPulse broke; exit code `1` means your project tripped a threshold.

## What is out of scope

- Help with Expo, React Native or EAS themselves. Try the
  [Expo forums](https://chat.expo.dev) or their documentation.
- Fixing findings in your project. ExpoPulse tells you what it found and why; the
  changes are yours to make.
- Private or commercial support. There is none.
