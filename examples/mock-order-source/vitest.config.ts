/**
 * Vitest config for the mock-order-source example app.
 *
 * Test files live under `__tests__/`. The conformance suite is imported from
 * the kit's own `packages/fulfilment-conformance` source by relative path
 * rather than as an npm dependency, because the package is not published
 * yet; an app in sprigr-apps declares it as an exact-pinned devDependency
 * instead (see `tools/create-app.mjs --template order-source`).
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
    },
  },
});
