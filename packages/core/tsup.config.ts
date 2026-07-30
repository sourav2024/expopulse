import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

// Single source of truth for the version: package.json. Inlining it at build
// time keeps the runtime free of a file read and makes drift impossible.
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
    __EXPOPULSE_VERSION__: JSON.stringify(version),
  },
  // sharp ships native binaries and must never be bundled.
  external: ['sharp'],
})
