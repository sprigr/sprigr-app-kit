/**
 * Realised supplier lead time from order lines and receipts.
 *
 * A build step calls this over the rows it keeps, and stores the three
 * figures per SKU from that SKU's supplier. The figure that sizes a buy is
 * picked at read time (resolveLeadTimeDetail in buyer-metrics.ts).
 */
import { daysBetween, percentile } from './po-scoring';

/** One purchase-order line. Keys are compared exactly as given. */
export interface LeadTimeOrderLine {
  po_ref: string;
  line_ref?: string | null;
  sku: string;
  supplier_ref: string;
  /** ISO date, YYYY-MM-DD. */
  ordered_on: string;
}

/** One receipt against an order. */
export interface LeadTimeReceipt {
  po_ref: string;
  line_ref?: string | null;
  sku: string;
  /** ISO date, YYYY-MM-DD. */
  received_on: string;
  qty: number;
}

export interface RealisedLeadTimeOptions {
  /** The cut the figures are computed at (ISO date); the window counts back from it. */
  as_of: string;
  /** Only lines ordered within this many calendar months before as_of count. Default 12. */
  window_months?: number;
  /** A line taking longer than this many days is a data error and is dropped. Default 180. */
  max_days?: number;
}

/** Whole days, nearest-rank, over a supplier's kept lines. */
export interface RealisedLeadTime {
  median_days: number;
  p90_days: number;
  receipt_count: number;
}

export const DEFAULT_LEAD_TIME_WINDOW_MONTHS = 12;
export const DEFAULT_LEAD_TIME_MAX_DAYS = 180;

const hasLineRef = (r: { line_ref?: string | null }): boolean => typeof r.line_ref === 'string' && r.line_ref !== '';

/** as_of minus `months` calendar months, the day clamped to the target month's last day. */
function windowStart(asOf: string, months: number): string {
  const [y, m, d] = asOf.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Per supplier_ref: the median and 90th percentile of days from an order
 * line's ordered_on to its first receipt with a positive quantity, and the
 * number of lines kept. A receipt matches on po_ref + line_ref when every
 * line and receipt carries a line_ref, otherwise on po_ref + sku; lines with
 * the same key are one line from the earliest ordered_on. A line is kept when
 * it was ordered within the window ending at as_of and took 1 to max_days
 * days: 0 means it was raised at receipt (unknown), and negative or over the
 * cap is a data error. Suppliers with no kept line are absent.
 */
export function realisedLeadTimes(
  lines: LeadTimeOrderLine[],
  receipts: LeadTimeReceipt[],
  opts: RealisedLeadTimeOptions,
): Record<string, RealisedLeadTime> {
  const windowMonths = opts.window_months ?? DEFAULT_LEAD_TIME_WINDOW_MONTHS;
  const maxDays = opts.max_days ?? DEFAULT_LEAD_TIME_MAX_DAYS;
  const from = windowStart(opts.as_of, windowMonths);
  const byLineRef = lines.length > 0 && receipts.length > 0 && lines.every(hasLineRef) && receipts.every(hasLineRef);
  const keyOf = (r: { po_ref: string; line_ref?: string | null; sku: string }): string =>
    JSON.stringify([r.po_ref, byLineRef ? r.line_ref : r.sku]);

  const firstReceipt = new Map<string, string>();
  for (const r of receipts) {
    if (!(r.qty > 0)) continue;
    const k = keyOf(r);
    const seen = firstReceipt.get(k);
    if (seen === undefined || r.received_on < seen) firstReceipt.set(k, r.received_on);
  }

  const orders = new Map<string, { supplier_ref: string; ordered_on: string }>();
  for (const l of lines) {
    const k = keyOf(l);
    const seen = orders.get(k);
    if (seen === undefined || l.ordered_on < seen.ordered_on) {
      orders.set(k, { supplier_ref: l.supplier_ref, ordered_on: l.ordered_on });
    }
  }

  const days = new Map<string, number[]>();
  for (const [k, o] of orders) {
    if (o.ordered_on < from || o.ordered_on > opts.as_of) continue;
    const d = daysBetween(o.ordered_on, firstReceipt.get(k) ?? null);
    if (d === null || d < 1 || d > maxDays) continue;
    const list = days.get(o.supplier_ref) ?? [];
    list.push(d);
    days.set(o.supplier_ref, list);
  }

  const out: Record<string, RealisedLeadTime> = {};
  for (const [supplier, list] of days) {
    out[supplier] = {
      median_days: percentile(list, 0.5)!,
      p90_days: percentile(list, 0.9)!,
      receipt_count: list.length,
    };
  }
  return out;
}
