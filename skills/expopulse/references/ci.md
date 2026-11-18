# CI, baselines and configuration

## Gate a pull request

Pin the version: rule IDs and scores can change before 1.0.

```yaml
- run: npx -y expopulse@0.2.0 analyze --format sarif --fail-on error
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: .expopulse/reports/expopulse-report.sarif
```

- `--fail-on error` (or `warning`, `critical`) sets the severity threshold. `--min-score 80` also fails below a score.
- Exit `1` means the threshold tripped. Exit `2` means ExpoPulse itself failed. Don't treat both the same.
- For an existing app with many findings, start with `--fail-on critical` or `error`, fix the blockers, then tighten.

## Baseline (track drift without fixing everything first)

```bash
npx -y expopulse@0.2.0 compare --save expopulse-baseline.json      # commit this file
npx -y expopulse@0.2.0 compare --baseline expopulse-baseline.json  # in CI or locally
```

`compare` reports the score delta and new or resolved findings. It always exits 0 unless it fails. To make CI fail, use `analyze --fail-on`/`--min-score`.

## Project config

`expopulse.config.mjs` (or `.ts` on Node 23.6+, `.expopulserc.json`, or an `expopulse` key in `package.json`):

```js
export default {
  ignore: ['**/generated/**', 'assets/marketing/**'],
  rules: {
    'react/no-inline-style': 'off',          // agreed noise for this codebase
    'ios/missing-privacy-manifest': 'error', // treat as a blocker
  },
  thresholds: { maxImageBytes: 500 * 1024, minScore: 80 },
  ci: { failOn: 'error', enforceScore: false },
}
```

Levels are `info`, `warning`, `error`, `critical`, `off`. Turn a rule down only after the team agrees it doesn't apply. Don't silence a finding just to make CI pass.

Add `.expopulse/` (cache, reports, fix backups) to `.gitignore`.
