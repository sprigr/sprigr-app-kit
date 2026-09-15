/**
 * The report shape every entry point returns, plus the small collector the
 * suites build it with.
 *
 * A check is never "skipped". A condition the harness could not exercise is
 * reported as a FAILED check naming what the caller has to supply, because a
 * silently-skipped check is the same as no check and reads as a pass.
 */

export interface ConformanceCheck {
  /** Stable dotted id, e.g. `push_order.idempotent_provider_ref`. */
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

  pass(name: string, detail: string): void {
    this.add(name, true, detail);
  }

  fail(name: string, detail: string): void {
    this.add(name, false, detail);
  }

  /** Turn a list of shape issues into one check. */
  issues(name: string, issues: string[], okDetail: string): void {
    this.add(name, issues.length === 0, issues.length === 0 ? okDetail : issues.join('; '));
  }

  report(): ConformanceReport {
    return { ok: this.checks.every((c) => c.ok), checks: this.checks };
  }
}

/** One-line-per-check rendering, for a test failure message or a CI log. */
export function formatReport(report: ConformanceReport): string {
  const lines = report.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  const failed = report.checks.filter((c) => !c.ok).length;
  lines.push(
    failed === 0
      ? `OK: ${report.checks.length} checks passed`
      : `FAILED: ${failed} of ${report.checks.length} checks`,
  );
  return lines.join('\n');
}
