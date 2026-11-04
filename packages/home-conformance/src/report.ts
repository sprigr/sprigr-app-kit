/**
 * The report every entry point returns, in the same shape as
 * `@sprigr/apps-fulfilment-conformance`, so a CI log reads the same.
 *
 * A check is never "skipped". A rule the harness could not exercise is a
 * FAILED check naming what the caller has to supply, because a silently
 * skipped check reads as a pass.
 */

export interface ConformanceCheck {
  /** Stable dotted id, e.g. `my_day.person_required`. */
  name: string;
  ok: boolean;
  /** Why it passed or, when it failed, exactly what was wrong. */
  detail: string;
}

export interface ConformanceReport {
  ok: boolean;
  checks: ConformanceCheck[];
}

export class CheckCollector {
  readonly checks: ConformanceCheck[] = [];
  add(name: string, ok: boolean, detail: string): void {
    this.checks.push({ name, ok, detail });
  }
  report(): ConformanceReport {
    return { ok: this.checks.every((c) => c.ok), checks: this.checks };
  }
}

/** One line per check, for a test failure message or a CI log. */
export function formatReport(report: ConformanceReport): string {
  const lines = report.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  const failed = report.checks.filter((c) => !c.ok).length;
  lines.push(failed === 0 ? `OK: ${report.checks.length} checks passed` : `FAILED: ${failed} of ${report.checks.length} checks`);
  return lines.join('\n');
}
