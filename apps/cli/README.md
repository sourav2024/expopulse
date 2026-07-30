# expopulse

Rule-based static analysis and optimisation platform for Expo applications.

ExpoPulse analyses an Expo project across code, assets, dependencies, configuration
and native platform layers. It does not just report problems: it explains them,
estimates their impact, recommends fixes, and applies the safe ones for you.

```bash
npx expopulse analyze
```

## Install

```bash
npm install --save-dev expopulse
# or run without installing
npx expopulse analyze
```

Requires Node.js 20 or newer.

## Commands

| Command | Purpose |
| --- | --- |
| `expopulse analyze` | Analyse the project and report findings (default) |
| `expopulse doctor` | Check the environment and project setup |
| `expopulse fix` | Apply safe automatic fixes, with preview and rollback |
| `expopulse compare` | Diff the project against a saved baseline |
| `expopulse report` | Generate HTML, Markdown, JSON or SARIF reports |

```bash
expopulse analyze --verbose            # rationale and recommendations
expopulse analyze --only expo,android  # restrict to specific layers
expopulse analyze --json               # machine-readable output on stdout
expopulse analyze --fail-on error      # exit 1 on any error-level finding
expopulse doctor --rules               # list every available rule

expopulse fix --dry-run                # preview, never writes
expopulse fix --yes                    # apply without prompting
expopulse fix --rollback <id>          # undo a previous run exactly
```

Exit codes: `0` clean, `1` findings tripped the configured threshold, `2` the tool
itself failed — so CI can tell "your project has issues" from "ExpoPulse broke".

## Analysis layers

Code, assets, dependencies, Expo configuration, Android and iOS. Layers that do not
apply are skipped rather than failed: a managed-workflow project with no `android/`
directory is not penalised for Android findings it cannot have.

## Configuration

Optional — ExpoPulse works with zero configuration. Create `expopulse.config.ts`:

```ts
import { defineConfig } from '@expopulse/core'

export default defineConfig({
  rules: {
    'react/no-inline-style': 'warning',
    'assets/duplicate-image': 'error',
    'deps/unused-dependency': 'off',
  },
  thresholds: { maxImageBytes: 500 * 1024, minScore: 80 },
  ci: { failOn: 'error' },
})
```

## Documentation

Full documentation, including every rule and the known limitations of static
analysis, is in the [project README](https://github.com/truxo/expopulse#readme).

## Licence

MIT
