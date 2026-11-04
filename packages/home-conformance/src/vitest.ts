/**
 * Vitest binding: one `describeHomeConformance(...)` call in an app's tests
 * runs the whole suite once and asserts every check, naming each failed rule.
 *
 * A separate entry point (`@sprigr/apps-home-conformance/vitest`): the main
 * entry must stay importable inside a Worker, and a static `import 'vitest'`
 * there would break that.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { formatReport, type ConformanceReport } from './report';
import { runHomeConformance, type HomeConformanceOptions } from './run';

export function describeHomeConformance<Env>(title: string, opts: HomeConformanceOptions<Env>): void {
  describe(`${title}: Sprigr Home contracts conformance`, () => {
    let report: ConformanceReport;
    beforeAll(async () => {
      report = await runHomeConformance(opts);
    }, Math.max(30_000, (opts.timeBudgetMs ?? 2000) * 40));

    it('passes every check', () => {
      const failed = report.checks.filter((c) => !c.ok);
      expect(failed.map((c) => `${c.name}: ${c.detail}`), formatReport(report)).toEqual([]);
    });
  });
}
