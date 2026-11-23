/**
 * Realised supplier lead time from order lines and receipts: the days from an
 * order to its first receipt with a positive quantity, summarised per
 * supplier. No I/O; the caller passes plain rows.
 */

import { percentile } from './po-scoring';

export interface LeadTimeOrderLine {
  po_ref: string;
  /** Matched against a receipt's `line_ref` when the receipt carries one. */
  line_ref?: string | null;
  sku: string;
  /** The figures are keyed by this; a line without one is not counted. */
  supplier_ref?: string | null;
  ordered_on: Date | string | number;
}

export interface LeadTimeReceipt {
  po_ref: string;
  /** With one, the receipt matches on po_ref + line_ref; without, on po_ref + sku. */
  line_ref?: string | null;
  sku: string;
  received_on: Date | string | number;
  qty: number;
}

export interface RealisedLeadTimeOptions {
  /** The end of the window. */
  asOf: Date | string | number;
  /** Lines ordered in this many calendar months before `asOf` count. Default 12. */
  lead_time_window_months?: number;
  /** The longest lead time kept, in days; a longer one is dropped as a data error. Default 180. */
  lead_time_max_days?: number;
  /** Counted lines a supplier needs before a median and p90 are returned. Default 20. */
  lead_time_min_receipts?: number;
}

export interface RealisedLeadTime {
  /** Nearest-rank median in days; null below `lead_time_min_receipts`. */
  median_days: number | null;
  /** Nearest-rank 90th percentile in days; null below `lead_time_min_receipts`. */
  p90_days: number | null;
  /** Order lines with a counted lead time. */
  receipt_count: number;
}

/** The defaults realisedLeadTimes uses for the optional options. */
export const DEFAULT_REALISED_LEAD_TIME_OPTIONS = {
  lead_time_window_months: 12,
  lead_time_max_days: 180,
  lead_time_min_receipts: 20,
} as const;

const DAY_MS = 86_400_000;

/** Whole UTC days since the epoch; null for anything that is not a date. */
function utcDay(v: unknown): number | null {
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? Math.floor(t / DAY_MS) : null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const positive = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;

/** The UTC day `months` calendar months before `day`, clamped to the shorter month's end. */
function monthsBefore(day: number, months: number): number {
  const d = new Date(day * DAY_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - months;
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(y, m, Math.min(d.getUTCDate(), lastOfMonth)) / DAY_MS);
}

const key = (a: string, b: string): string => `${a}\u0000${b}`;

/**
 * Realised lead time per supplier, keyed by the order line's `supplier_ref`.
 *
 * A receipt with a `line_ref` matches its order line on po_ref + line_ref.
 * Order lines no such receipt matches are grouped on po_ref + sku, from the
 * group's earliest order date, and match receipts without a `line_ref`. A
 * group counts when its first receipt with a positive quantity lands 1 to
 * `lead_time_max_days` days (UTC calendar days) after the order: a same-day
 * receipt means the order was raised at receipt, so it is unknown, not zero.
 * po_ref is compared as given; making the two sides agree is the caller's job.
 * Below `lead_time_min_receipts` a supplier gets its count and no figures.
 */
export function realisedLeadTimes(
  lines: ReadonlyArray<LeadTimeOrderLine>,
  receipts: ReadonlyArray<LeadTimeReceipt>,
  options: RealisedLeadTimeOptions,
): Map<string, RealisedLeadTime> {
  const d = DEFAULT_REALISED_LEAD_TIME_OPTIONS;
  const windowMonths = positive(options.lead_time_window_months, d.lead_time_window_months);
  const maxDays = positive(options.lead_time_max_days, d.lead_time_max_days);
  const minReceipts = positive(options.lead_time_min_receipts, d.lead_time_min_receipts);
  const asOfDay = utcDay(options.asOf);
  const out = new Map<string, RealisedLeadTime>();
  if (asOfDay === null) return out;
  const fromDay = monthsBefore(asOfDay, Math.floor(windowMonths));

  // First positive receipt day per match key.
  const byLine = new Map<string, number>();
  const bySku = new Map<string, number>();
  for (const r of receipts) {
    const po = text(r.po_ref);
    const day = utcDay(r.received_on);
    if (!po || day === null || !(Number(r.qty) > 0)) continue;
    const lineRef = text(r.line_ref);
    const map = lineRef ? byLine : bySku;
    const k = lineRef ? key(po, lineRef) : key(po, text(r.sku));
    const prev = map.get(k);
    if (prev === undefined || day < prev) map.set(k, day);
  }

  // One group per matched line, else per po_ref + sku.
  const groups = new Map<string, { supplier: string; ordered: number; received: number | undefined }>();
  for (const l of lines) {
    const po = text(l.po_ref);
    const supplier = text(l.supplier_ref);
    const ordered = utcDay(l.ordered_on);
    if (!po || !supplier || ordered === null || ordered < fromDay || ordered > asOfDay) continue;
    const lineRef = text(l.line_ref);
    const lineKey = lineRef ? key(po, lineRef) : '';
    if (lineKey && byLine.has(lineKey)) {
      groups.set(`L${lineKey}`, { supplier, ordered, received: byLine.get(lineKey) });
      continue;
    }
    const skuKey = key(po, text(l.sku));
    const g = groups.get(`S${skuKey}`);
    if (g) g.ordered = Math.min(g.ordered, ordered);
    else groups.set(`S${skuKey}`, { supplier, ordered, received: bySku.get(skuKey) });
  }

  const daysBySupplier = new Map<string, number[]>();
  for (const g of groups.values()) {
    if (g.received === undefined) continue;
    const days = g.received - g.ordered;
    if (days < 1 || days > maxDays) continue;
    const list = daysBySupplier.get(g.supplier) ?? [];
    list.push(days);
    daysBySupplier.set(g.supplier, list);
  }
  for (const [supplier, days] of daysBySupplier) {
    const enough = days.length >= minReceipts;
    out.set(supplier, {
      median_days: enough ? percentile(days, 0.5) : null,
      p90_days: enough ? percentile(days, 0.9) : null,
      receipt_count: days.length,
    });
  }
  return out;
}
