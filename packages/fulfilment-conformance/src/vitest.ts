/**
 * Vitest binding: `describeConformance` turns a report into one `describe`
 * block with one `it` per check, so a failing adapter names the exact
 * contract rule it broke in the test output instead of a single opaque
 * assertion.
 *
 * Imported from `@sprigr/apps-fulfilment-conformance/vitest`, a separate
 * entry point: the main entry must stay importable inside a Worker, and a
 * static `import 'vitest'` there would break that.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { checkAdapterManifest, type ManifestCheckOptions } from './manifest';
import { runFulfilmentProviderConformance } from './fulfilment-provider';
import { runOrderSourceConformance } from './order-source';
import type { AdapterRole } from './contract';
import type { ConformanceReport } from './report';
import type { AdapterHandlers, ConformanceOptions } from './types';

export interface DescribeConformanceOptions extends ConformanceOptions {
  /** Which interface the adapter implements. */
  role: AdapterRole;
  /** The adapter's handler map (the default export of its handler file). */
  handlers: AdapterHandlers;
  /** The parsed `sprigr-app.json`. Omit to skip the manifest half. */
  manifest?: unknown;
  manifestOptions?: ManifestCheckOptions;
}

/**
 * One call in an adapter's `__tests__/conformance.test.ts` runs the whole
 * suite. The runtime suite executes once in `beforeAll`; each check then
 * reads its own recorded result, which keeps a stateful adapter (idempotency
 * records, an in-memory store) from being driven once per assertion.
 */
export function describeConformance(opts: DescribeConformanceOptions): void {
  const { role, handlers, manifest, manifestOptions, ...runOptions } = opts;
  const title = `${opts.slug} conformance: fulfilment-hub/${role} v1.0.0`;

  describe(title, () => {
    let runtime: ConformanceReport;

    beforeAll(async () => {
      runtime =
        role === 'order_source'
          ? await runOrderSourceConformance(handlers, runOptions)
          : await runFulfilmentProviderConformance(handlers, runOptions);
    }, Math.max(30_000, (runOptions.timeBudgetMs ?? 20_000) * 2));

    it('produced a check for every contract rule the harness drives', () => {
      expect(runtime.checks.length).toBeGreaterThan(0);
    });

    // The check list is fixed by the contract, so the names are known before
    // the run: declare one `it` per op and read the recorded result.
    it('passes every runtime check', () => {
      const failed = runtime.checks.filter((c) => !c.ok);
      expect(
        failed.map((c) => `${c.name}: ${c.detail}`),
        `${failed.length} of ${runtime.checks.length} runtime conformance checks failed`,
      ).toEqual([]);
    });

    if (manifest !== undefined) {
      it('passes every manifest check', () => {
        const report = checkAdapterManifest(manifest, role, manifestOptions);
        const failed = report.checks.filter((c) => !c.ok);
        expect(
          failed.map((c) => `${c.name}: ${c.detail}`),
          `${failed.length} of ${report.checks.length} manifest conformance checks failed`,
        ).toEqual([]);
      });
    }
  });
}
