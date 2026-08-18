import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and exits
      // the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-08-18 at 99.05 / 93.08 / 99.09 / 99.14, with roughly
      // five points of headroom on functions. Write the missing tests instead
      // of lowering them.
      thresholds: {
        statements: 97,
        branches: 90,
        functions: 94,
        lines: 97,
      },
    },
  },
});
