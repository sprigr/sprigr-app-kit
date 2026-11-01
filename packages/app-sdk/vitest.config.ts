import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Every stubbed fetch refuses what the Workers runtime refuses (#10981).
    setupFiles: ['tests/setup/workers-fetch.ts'],
    // Type-level tests (*.test-d.ts) run with `vitest run`, so a type
    // regression fails CI too (verify runs no tsc).
    typecheck: {
      enabled: true,
      include: ['tests/**/*.test-d.ts'],
      tsconfig: './tsconfig.typecheck.json',
    },
  },
});
