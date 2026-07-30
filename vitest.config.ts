import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Analyzer tests touch the filesystem in temp dirs; keep them serial-safe
    // by isolating each file in its own worker.
    isolate: true,
    testTimeout: 30_000,
  },
})
