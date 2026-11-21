/** Every way this package refuses. A caller can switch on `reason`. */
export const REPORTING_REASONS = [
  // sql
  'bad_identifier', 'bad_number', 'bad_date',
  // formula
  'formula_empty', 'formula_too_long', 'formula_syntax', 'formula_unknown_function', 'formula_arity',
  'formula_type', 'formula_function_unsupported', 'formula_unknown_measure', 'formula_cycle',
  // periods
  'unknown_period', 'period_range_inverted', 'too_many_periods', 'bad_grain',
  // view
  'mode_unsupported', 'unknown_stream', 'unknown_dimension', 'unknown_measure', 'unknown_property',
  'no_measures', 'duplicate_measure', 'measure_not_on_stream', 'snapshot_measure_unsupported',
  'dimension_not_on_stream', 'dimension_has_no_table', 'empty_selection', 'filter_too_deep',
  'empty_filter', 'measure_filter_unsupported', 'option_unsupported', 'keyword_too_long',
  'unknown_column', 'bad_across', 'bad_sort', 'bad_paging', 'sql_too_long', 'no_rollup',
] as const;

export type ReportingReason = (typeof REPORTING_REASONS)[number];

export class ReportingError extends Error {
  readonly reason: ReportingReason;
  readonly detail: string;
  constructor(reason: ReportingReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'ReportingError';
    this.reason = reason;
    this.detail = detail;
  }
}

export interface Refusal {
  ok: false;
  reason: ReportingReason;
  detail: string;
}

/** Turn a thrown ReportingError into a refusal; anything else is a bug and is rethrown. */
export function refusalOf(err: unknown): Refusal {
  if (err instanceof ReportingError) return { ok: false, reason: err.reason, detail: err.detail };
  throw err;
}
