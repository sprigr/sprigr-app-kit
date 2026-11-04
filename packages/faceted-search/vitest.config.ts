import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Two projects, split by environment: the `*.dom.test.tsx` suites run under
 * jsdom, everything else under node. `environmentMatchGlobs` is deprecated in
 * vitest 3 and removed in vitest 4 in favour of `test.projects`. Same shape as
 * the sprigr-apps copy this package is replacing (sprigr-apps#4484).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, '**/*.dom.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['__tests__/**/*.dom.test.{ts,tsx}'],
        },
      },
    ],
  },
});
