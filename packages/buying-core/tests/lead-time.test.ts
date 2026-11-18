import { describe, it, expect } from 'vitest';
import { realisedLeadTimes } from '../src';

// Realised lead time per supplier from order lines and receipts: days from
// the order to the first receipt with a positive quantity.

const AS_OF = new Date('2026-11-01T00:00:00Z');

type Line = { po_ref: string; line_ref?: string | null; sku: string; supplier_ref?: string | null; ordered_on: Date | string };
type Receipt = { po_ref: string; line_ref?: string | null; sku: string; received_on: Date | string; qty: number };

const line = (po_ref: string, sku: string, supplier_ref: string | null, ordered_on: Date | string, line_ref: string | null = null): Line => ({
  po_ref,
  line_ref,
  sku,
  supplier_ref,
  ordered_on,
});
const receipt = (po_ref: string, sku: string, received_on: string, qty: number, line_ref: string | null = null): Receipt => ({
  po_ref,
  line_ref,
  sku,
  received_on,
  qty,
});

/** n orders for supplier S, each received `days` after it was placed. */
function orders(n: number, days: number): { lines: Line[]; receipts: Receipt[] } {
  const lines: Line[] = [];
  const receipts: Receipt[] = [];
  for (let i = 0; i < n; i++) {
    const ordered = new Date(Date.UTC(2026, 5, 1 + i));
    const received = new Date(ordered.getTime() + days * 86_400_000);
    lines.push(line(`PO-${i}`, 'SKU-A', 'S', ordered.toISOString()));
    receipts.push(receipt(`PO-${i}`, 'SKU-A', received.toISOString(), 1));
  }
  return { lines, receipts };
}

describe('realisedLeadTimes', () => {
  it('counts the days from the order to the first receipt with a positive quantity', () => {
    const out = realisedLeadTimes(
      [line('PO-1', 'SKU-A', 'S', new Date('2026-06-01T00:00:00Z'))],
      [
        receipt('PO-1', 'SKU-A', '2026-06-03', 0),
        receipt('PO-1', 'SKU-A', '2026-06-20', 5),
        receipt('PO-1', 'SKU-A', '2026-06-08', 5),
      ],
      { asOf: AS_OF, lead_time_min_receipts: 1 },
    );
    expect(out.get('S')).toEqual({ median_days: 7, p90_days: 7, receipt_count: 1 });
  });

  it('drops a same-day receipt as unknown, and a negative or over-the-cap lead time as a data error', () => {
    const lines = [
      line('PO-SAME', 'SKU-A', 'S', '2026-06-01'),
      line('PO-NEG', 'SKU-A', 'S', '2026-06-10'),
      line('PO-LONG', 'SKU-A', 'S', '2026-01-02'),
      line('PO-OK', 'SKU-A', 'S', '2026-06-01'),
    ];
    const receipts = [
      receipt('PO-SAME', 'SKU-A', '2026-06-01', 4),
      receipt('PO-NEG', 'SKU-A', '2026-06-05', 4),
      receipt('PO-LONG', 'SKU-A', '2026-08-01', 4), // 211 days
      receipt('PO-OK', 'SKU-A', '2026-06-11', 4), // 10 days
    ];
    expect(realisedLeadTimes(lines, receipts, { asOf: AS_OF, lead_time_min_receipts: 1 }).get('S')).toEqual({
      median_days: 10,
      p90_days: 10,
      receipt_count: 1,
    });
    // A higher cap keeps the 211-day line.
    expect(
      realisedLeadTimes(lines, receipts, { asOf: AS_OF, lead_time_min_receipts: 1, lead_time_max_days: 365 }).get('S')
        ?.receipt_count,
    ).toBe(2);
  });

  it('matches a receipt that carries a line_ref on po_ref + line_ref', () => {
    const lines = [line('PO-8', 'SKU-A', 'S', '2026-05-01', 'L1'), line('PO-8', 'SKU-A', 'S', '2026-05-11', 'L2')];
    const receipts = [receipt('PO-8', 'SKU-A', '2026-05-06', 2, 'L1'), receipt('PO-8', 'SKU-A', '2026-05-14', 2, 'L2')];
    expect(realisedLeadTimes(lines, receipts, { asOf: AS_OF, lead_time_min_receipts: 1 }).get('S')).toEqual({
      median_days: 3,
      p90_days: 5,
      receipt_count: 2,
    });
  });

  it('matches a receipt with no line_ref on po_ref + sku, one group per order and sku from its earliest order date', () => {
    const lines = [line('PO-8', 'SKU-A', 'S', '2026-05-01', 'L1'), line('PO-8', 'SKU-A', 'S', '2026-05-11', 'L2')];
    const receipts = [receipt('PO-8', 'SKU-A', '2026-05-06', 2), receipt('PO-8', 'SKU-A', '2026-05-14', 2)];
    expect(realisedLeadTimes(lines, receipts, { asOf: AS_OF, lead_time_min_receipts: 1 }).get('S')).toEqual({
      median_days: 5,
      p90_days: 5,
      receipt_count: 1,
    });
  });

  it('compares po_ref as given', () => {
    const out = realisedLeadTimes(
      [line('000123', 'SKU-A', 'S', '2026-06-01')],
      [receipt('123', 'SKU-A', '2026-06-05', 1)],
      { asOf: AS_OF, lead_time_min_receipts: 1 },
    );
    expect(out.size).toBe(0);
  });

  it('counts only lines ordered inside lead_time_window_months before asOf', () => {
    const lines = [line('PO-OLD', 'SKU-A', 'S', '2025-10-15'), line('PO-NEW', 'SKU-A', 'S', '2026-02-01')];
    const receipts = [receipt('PO-OLD', 'SKU-A', '2025-10-20', 1), receipt('PO-NEW', 'SKU-A', '2026-02-05', 1)];
    // Default window 12 months: from 2025-11-01, so only the newer line.
    expect(realisedLeadTimes(lines, receipts, { asOf: AS_OF, lead_time_min_receipts: 1 }).get('S')).toEqual({
      median_days: 4,
      p90_days: 4,
      receipt_count: 1,
    });
    expect(
      realisedLeadTimes(lines, receipts, { asOf: AS_OF, lead_time_min_receipts: 1, lead_time_window_months: 13 }).get('S')
        ?.receipt_count,
    ).toBe(2);
  });

  it('below lead_time_min_receipts (default 20) returns the count and no median or p90', () => {
    const few = orders(19, 5);
    expect(realisedLeadTimes(few.lines, few.receipts, { asOf: AS_OF }).get('S')).toEqual({
      median_days: null,
      p90_days: null,
      receipt_count: 19,
    });
    const enough = orders(20, 5);
    expect(realisedLeadTimes(enough.lines, enough.receipts, { asOf: AS_OF }).get('S')).toEqual({
      median_days: 5,
      p90_days: 5,
      receipt_count: 20,
    });
  });

  it('takes the median and p90 by nearest rank', () => {
    const lines: Line[] = [];
    const receipts: Receipt[] = [];
    for (let d = 1; d <= 10; d++) {
      lines.push(line(`PO-${d}`, 'SKU-A', 'S', '2026-06-01'));
      receipts.push(receipt(`PO-${d}`, 'SKU-A', new Date(Date.UTC(2026, 5, 1 + d)).toISOString(), 1));
    }
    expect(realisedLeadTimes(lines, receipts, { asOf: AS_OF, lead_time_min_receipts: 1 }).get('S')).toEqual({
      median_days: 5,
      p90_days: 9,
      receipt_count: 10,
    });
  });

  it('keys by the order line supplier, and counts no line without a supplier or a receipt', () => {
    const lines = [
      line('PO-1', 'SKU-A', 'S1', '2026-06-01'),
      line('PO-2', 'SKU-A', 'S2', '2026-06-01'),
      line('PO-3', 'SKU-A', null, '2026-06-01'),
      line('PO-4', 'SKU-A', 'S3', '2026-06-01'),
    ];
    const receipts = [
      receipt('PO-1', 'SKU-A', '2026-06-04', 1),
      receipt('PO-2', 'SKU-A', '2026-06-07', 1),
      receipt('PO-3', 'SKU-A', '2026-06-02', 1),
    ];
    const out = realisedLeadTimes(lines, receipts, { asOf: AS_OF, lead_time_min_receipts: 1 });
    expect([...out.keys()].sort()).toEqual(['S1', 'S2']);
    expect(out.get('S1')?.median_days).toBe(3);
    expect(out.get('S2')?.median_days).toBe(6);
  });
});
