# Triage

Put every finding into one bucket, in this order. The rule-to-bucket map is in `rules.md`.

## B — Release blockers

The build fails, the store rejects the upload, or the app crashes on a code path.

Always included, whatever the configured severity:

- Store minimums: `android/target-sdk-outdated`, `ios/missing-privacy-manifest`
- iOS purpose strings: `ios/missing-usage-description`, `ios/empty-usage-description`
- Broken config: `expo/missing-bundle-identifier`, `expo/missing-android-package`, `expo/icon-file-missing`, `expo/referenced-asset-missing`, `expo/orphaned-config-plugin`
- Versions: `expo/sdk-eol`, `expo/react-version-mismatch`, `expo/react-native-version-mismatch`, `deps/missing-dependency`
- OTA safety: `expo/missing-runtime-version` (only when expo-updates ships updates)

Report each one individually, with evidence and the fix.

## R — Store-review risk

Review delays, declaration forms, or user-trust problems: `android/dangerous-permission`, `android/cleartext-traffic-enabled`, `ios/generic-usage-description`, `ios/arbitrary-loads-enabled`, `ios/background-mode-unjustified`, icons and scheme.

Report each one, and say what the reviewer will ask.

## S — Size

Download size and install conversion. Rank by `estimatedImpact.bytes` (`summarize.mjs` totals it) and report the biggest few with numbers:

- assets: oversized, unused, duplicates
- `android/minify-disabled`
- broad `assetBundlePatterns`
- heavy dependencies

Remember the numbers are estimates.

## P — Runtime performance

Startup and list smoothness: FlatList rules, `require-in-render`, Hermes, memoisation in list rows.

Report the ones in screens the user cares about, or in long lists.

## H — Hygiene

Everything else, including most `info` findings: inline styles, console calls, large files, informational config.

Give counts per rule in one short list. Don't enumerate.

## Handling volume

- Never paste raw findings. Use `node scripts/summarize.mjs <json>` and `--rule <id>` to drill in.
- When one rule produces hundreds of hits (often `react/no-inline-style`, `performance/console-in-production`, `code/unused-import`), report the count and one example.
- If the user asked about one area (for example "why is the APK so big"), re-run with `--only` and stay inside that area.
- If a rule is noisy for this codebase and the team agrees, suggest turning it down in the config (`ci.md`) instead of re-reporting it every time.

## Score

The 0–100 score is a weighted summary, useful for tracking a trend with `compare`. Don't present it as a quality grade, and don't chase it. One release blocker matters more than ten points.
