/**
 * Vitest config for the harvest marketplace app.
 *
 * Test files live under `__tests__/` (mirroring the source tree).
 * Coverage is opt-in via `pnpm test -- --coverage`; vendored packages
 * are excluded because they're tested upstream in `packages/`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    exclude: ['__tests__/__helpers__/**', '**/node_modules/**', '**/dist/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/vendor/**'],
    },
  },
});
