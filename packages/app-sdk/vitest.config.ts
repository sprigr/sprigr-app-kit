import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Every stubbed fetch refuses what the Workers runtime refuses (#10981).
    setupFiles: ['tests/setup/workers-fetch.ts'],
  },
});
