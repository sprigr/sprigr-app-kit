import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    // Type-level tests (*.test-d.ts) run with `vitest run`, so CI's
    // `pnpm -r test` fails on a type regression too (verify runs no tsc).
    typecheck: {
      enabled: true,
      include: ['__tests__/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
