import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

// Single source of truth for the version: package.json.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  define: {
    __EXPOPULSE_CLI_VERSION__: JSON.stringify(version),
  },
  // Required for the `bin` entry to be directly executable.
  banner: { js: '#!/usr/bin/env node' },
  external: ['sharp'],
})
