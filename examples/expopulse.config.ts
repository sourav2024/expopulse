/**
 * Example ExpoPulse configuration.
 *
 * Copy this to your project root as `expopulse.config.ts`. Every field is
 * optional — ExpoPulse works with no configuration at all.
 */
import { defineConfig } from '@expopulse/core'

export default defineConfig({
  // Extra paths to exclude. Sensible defaults (node_modules, .expo, build
  // output, ios/Pods, android/build) are always applied on top of these.
  ignore: ['**/generated/**', '**/*.stories.tsx'],

  // Which source files the code layer analyses.
  include: ['**/*.{js,jsx,ts,tsx}'],

  // Per-rule levels: 'info' | 'warning' | 'error' | 'critical' | 'off'.
  // Run `expopulse doctor --rules` to list every available rule.
  rules: {
    // Promote issues that matter to your team.
    'assets/duplicate-image': 'error',
    'expo/missing-runtime-version': 'error',

    // Demote or silence ones that do not.
    'react/no-inline-style': 'info',
    'react/no-anonymous-callback': 'off',

    // Heuristic rules worth disabling if they are noisy in your codebase.
    'deps/unused-dependency': 'off',
  },

  thresholds: {
    // Images above this are flagged as oversized.
    maxImageBytes: 500 * 1024,
    // Non-image assets above this are flagged.
    maxAssetBytes: 2 * 1024 * 1024,
    // Installed dependencies above this are reported.
    maxDependencyBytes: 1024 * 1024,
    // Used by `--min-score` and `ci.enforceScore`.
    minScore: 85,
  },

  report: {
    formats: ['cli', 'html'],
    outDir: '.expopulse/reports',
    // Always include rationale and recommendations.
    verbose: false,
  },

  fix: {
    // Back up every file before modifying it. Strongly recommended.
    backup: true,
    // Set true only in automation that has reviewed the fixes.
    yes: false,
    dryRun: false,
    // Converts PNG/JPEG to WebP. Off by default: it changes file extensions,
    // so you must update imports yourself.
    convertToWebp: false,
  },

  ci: {
    // Fail the build at or above this severity. 'never' disables the check.
    failOn: 'error',
    // Also fail when the overall score drops below thresholds.minScore.
    enforceScore: false,
  },

  cache: {
    enabled: true,
    dir: '.expopulse/cache',
  },
})
