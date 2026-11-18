import { describe, it, expect } from 'vitest';
import {
  scorePo,
  rollupSuppliers,
  DEFAULT_PO_SCORING_THRESHOLDS,
  type PurchaseOrderRow,
  type PoScored,
} from '../src/po-scoring';

/** A zero-filled PO row; override only the fields a case cares about. */
const po = (o: Partial<PurchaseOrderRow> & { po_number: string; supplier: string }): PurchaseOrderRow => ({
  ordered_date: '2026-01-01',
  original_eta: '2026-02-01',
  latest_eta: '2026-02-05',
  units_total: 0,
  units_incoming: 0,
  units_in_stock: 0,
  units_sold: 0,
  units_cancelled: 0,
  total_cost: null,
  sold_cost: null,
  sold_revenue: null,
  avg_days_to_sell: null,
  oldest_unsold_days: null,
  unsold_over_90d: 0,
  unsold_over_180d: 0,
  ...o,
});

describe('scorePo', () => {
  it('grades a fast-sold high-margin PO A / green / reorder', () => {
    const r = scorePo(
      po({
        po_number: 'PO-A', supplier: 'Brand F Supply',
        units_total: 50, units_in_stock: 4, units_sold: 44, units_cancelled: 2,
        total_cost: 5000, sold_cost: 4400, sold_revenue: 8800, avg_days_to_sell: 26,
      }),
    );
    expect(r.received).toBe(48);
    expect(r.sell_through_pct).toBeCloseTo(91.67, 1);
    expect(r.margin).toBe(4400);
    expect(r.margin_pct).toBeCloseTo(50, 5);
    expect(r.gmroi).toBeCloseTo(0.88, 5);
    expect(r.aged_over_90_pct).toBe(0);
    expect(r.has_dead_stock).toBe(false);
    expect(r.grade).toBe('A');
    expect(r.rag).toBe('green');
    expect(r.signal).toBe('reorder');
  });

  it('grades a solid PO B / green (some stock left, so not a reorder)', () => {
    const r = scorePo(
      po({
        po_number: 'PO-B', supplier: 'Supplier S Intl',
        units_total: 40, units_in_stock: 14, units_sold: 24, units_cancelled: 2,
        total_cost: 6000, sold_cost: 3600, sold_revenue: 5400, avg_days_to_sell: 41,
      }),
    );
    // received 38, sell-through 63.2%, margin 1800, gmroi 0.30.
    expect(r.received).toBe(38);
    expect(r.sell_through_pct).toBeCloseTo(63.16, 1);
    expect(r.gmroi).toBeCloseTo(0.3, 5);
    // st >= 55 but gmroi 0.30 < 0.35 → not B; st >= 40 → C rescue band.
    expect(r.grade).toBe('C');
    expect(r.rag).toBe('amber');
    expect(r.signal).toBe('watch');
  });

  it('grades a genuine B when both sell-through and GMROI clear the bar', () => {
    const r = scorePo(
      po({
        po_number: 'PO-B2', supplier: 'Brand R',
        units_total: 40, units_in_stock: 14, units_sold: 24, units_cancelled: 2,
        total_cost: 4800, sold_cost: 3000, sold_revenue: 5000, avg_days_to_sell: 40,
      }),
    );
    // received 38, sell-through 63.2%, margin 2000, gmroi 0.417 (>= 0.35).
    expect(r.sell_through_pct).toBeCloseTo(63.16, 1);
    expect(r.gmroi).toBeCloseTo(0.42, 1);
    expect(r.grade).toBe('B');
    expect(r.rag).toBe('green');
    expect(r.signal).toBe('watch');
  });

  it('grades an aged low-sell-through PO with 180d+ stock D / red / markdown', () => {
    const r = scorePo(
      po({
        po_number: 'PO-D', supplier: 'Brand D Supply',
        units_total: 20, units_in_stock: 16, units_sold: 3, units_cancelled: 1,
        total_cost: 9000, sold_cost: 1350, sold_revenue: 1800, avg_days_to_sell: 210,
        oldest_unsold_days: 400, unsold_over_90d: 16, unsold_over_180d: 12,
      }),
    );
    expect(r.received).toBe(19);
    expect(r.sell_through_pct).toBeCloseTo(15.79, 1);
    expect(r.has_dead_stock).toBe(true);
    expect(r.aged_over_90_pct).toBeCloseTo(100, 5);
    expect(r.grade).toBe('D');
    expect(r.rag).toBe('red');
    expect(r.signal).toBe('markdown');
  });

  it('drops a thin-margin mostly-sold PO to D despite high sell-through (GMROI < 0.2)', () => {
    const r = scorePo(
      po({
        po_number: 'PO-THIN', supplier: 'Brand F Supply',
        units_total: 60, units_in_stock: 8, units_sold: 50, units_cancelled: 2,
        total_cost: 9000, sold_cost: 7500, sold_revenue: 8000, avg_days_to_sell: 33,
      }),
    );
    // received 58, sell-through 86.2%, margin 500, gmroi 0.056 → D by GMROI.
    expect(r.sell_through_pct).toBeCloseTo(86.21, 1);
    expect(r.margin).toBe(500);
    expect(r.gmroi).toBeCloseTo(0.06, 2);
    expect(r.grade).toBe('D');
    expect(r.rag).toBe('red');
    // Not markdown (sell-through high, nothing aged), not reorder (weak GMROI).
    expect(r.signal).toBe('watch');
  });

  it('parks a fully-incoming PO (received 0) at C / amber / watch with null sell-through', () => {
    const r = scorePo(
      po({
        po_number: 'PO-INC', supplier: 'Supplier Z Distribution',
        units_total: 100, units_incoming: 100, units_in_stock: 0, units_sold: 0,
        total_cost: 4000, sold_cost: null, sold_revenue: null, avg_days_to_sell: null,
      }),
    );
    expect(r.received).toBe(0);
    expect(r.sell_through_pct).toBeNull();
    expect(r.margin).toBe(0);
    expect(r.margin_pct).toBeNull(); // no sold revenue
    // GMROI is 0 here (no realised margin), but the incoming case is not a fail.
    expect(r.gmroi).toBe(0);
    expect(r.aged_over_90_pct).toBe(0);
    expect(r.grade).toBe('C');
    expect(r.rag).toBe('amber');
    expect(r.signal).toBe('watch');
  });

  it('never leaks NaN/Infinity: a zero-cost, zero-revenue PO yields nulls, not divide-by-zero', () => {
    const r = scorePo(po({ po_number: 'PO-ZERO', supplier: 'Nobody', units_total: 2, units_in_stock: 1, units_sold: 1 }));
    expect(r.sell_through_pct).toBe(50); // received 2, sold 1
    expect(r.margin).toBe(0);
    expect(r.margin_pct).toBeNull(); // sold_revenue null → 0 → no denominator
    expect(r.gmroi).toBeNull(); // total_cost null → 0 → no denominator
    expect(Number.isFinite(r.aged_over_90_pct)).toBe(true);
  });
});

/**
 * Stock that landed days ago was graded on the same thresholds as old
 * stock, so a fresh delivery read D / red / markdown.
 */
describe('scorePo: too early to judge', () => {
  // Worked example: 98 in stock, 2 sold, 4,900 landed cost.
  const fresh = (days: number | null) =>
    po({
      po_number: 'PO-NEW', supplier: 'Brand P & Q',
      units_total: 100, units_in_stock: 98, units_sold: 2,
      total_cost: 4900, sold_cost: 100, sold_revenue: 120,
      oldest_unsold_days: days,
    });

  it('a PO whose oldest unsold unit landed 6 days ago is C / amber / watch with a too-early reason', () => {
    const r = scorePo(fresh(6));
    expect(r.grade).toBe('C');
    expect(r.rag).toBe('amber');
    expect(r.signal).toBe('watch');
    expect(r.reasons.map((x) => x.code)).toContain('TOO_EARLY_TO_JUDGE');
    expect(r.reasons.map((x) => x.code)).not.toContain('SELL_THROUGH_LOW');
  });

  it('the same PO past the window is still judged: D / markdown', () => {
    const r = scorePo(fresh(90));
    expect(r.grade).toBe('D');
    expect(r.signal).toBe('markdown');
  });

  it('an unknown landing age is judged exactly as before (never exempted by a missing value)', () => {
    expect(scorePo(fresh(null)).grade).toBe('D');
  });
});

describe('rollupSuppliers', () => {
  const scored: PoScored[] = [
    // Brand F Supply: one A (strong) + one D (thin margin) → avg points (4+1)/2 = 2.5 → Acceptable.
    scorePo(
      po({
        po_number: 'PO-A', supplier: 'Brand F Supply',
        units_total: 50, units_in_stock: 4, units_sold: 44, units_cancelled: 2,
        total_cost: 5000, sold_cost: 4400, sold_revenue: 8800, avg_days_to_sell: 26,
      }),
    ),
    scorePo(
      po({
        po_number: 'PO-THIN', supplier: 'Brand F Supply',
        units_total: 60, units_in_stock: 8, units_sold: 50, units_cancelled: 2,
        total_cost: 9000, sold_cost: 7500, sold_revenue: 8000, avg_days_to_sell: 33,
      }),
    ),
    // Brand D Supply: one D with dead stock → avg points 1 → At risk.
    scorePo(
      po({
        po_number: 'PO-D', supplier: 'Brand D Supply',
        units_total: 20, units_in_stock: 16, units_sold: 3, units_cancelled: 1,
        total_cost: 9000, sold_cost: 1350, sold_revenue: 1800, avg_days_to_sell: 210,
        oldest_unsold_days: 400, unsold_over_90d: 16, unsold_over_180d: 12,
      }),
    ),
  ];

  it('groups by supplier with weighted sell-through, avg GMROI, dead-stock units and tier', () => {
    const suppliers = rollupSuppliers(scored);
    // Sorted by total cost desc: Brand F Supply (14000) before Brand D Supply (9000).
    expect(suppliers.map((s) => s.supplier)).toEqual(['Brand F Supply', 'Brand D Supply']);

    const brandF = suppliers.find((s) => s.supplier === 'Brand F Supply')!;
    expect(brandF.po_count).toBe(2);
    expect(brandF.total_cost).toBe(14000);
    // received 48 + 58 = 106, sold 44 + 50 = 94 → 88.68%.
    expect(brandF.units_received).toBe(106);
    expect(brandF.units_sold).toBe(94);
    expect(brandF.sell_through_pct).toBeCloseTo(88.68, 1);
    // avg GMROI = (0.88 + 0.06) / 2 = 0.47.
    expect(brandF.avg_gmroi).toBeCloseTo(0.47, 2);
    expect(brandF.dead_stock_units).toBe(0);
    // grades A(4) + D(1) → avg 2.5 → Acceptable.
    expect(brandF.tier).toBe('Acceptable');

    const brandD = suppliers.find((s) => s.supplier === 'Brand D Supply')!;
    expect(brandD.po_count).toBe(1);
    expect(brandD.dead_stock_units).toBe(12);
    expect(brandD.sell_through_pct).toBeCloseTo(15.79, 1);
    // single D → avg points 1 → At risk.
    expect(brandD.tier).toBe('At risk');
  });

  it('rates an all-A supplier Preferred and an all-C supplier Acceptable', () => {
    const preferred = rollupSuppliers([
      scorePo(
        po({
          po_number: 'PO-A1', supplier: 'Ace Co',
          units_total: 20, units_in_stock: 2, units_sold: 18,
          total_cost: 2000, sold_cost: 1800, sold_revenue: 3600, avg_days_to_sell: 20,
        }),
      ),
    ]);
    expect(preferred[0]!.tier).toBe('Preferred'); // one A → 4 points

    const acceptable = rollupSuppliers([
      scorePo(
        po({
          po_number: 'PO-C1', supplier: 'Mid Co',
          units_total: 100, units_incoming: 100, units_in_stock: 0, units_sold: 0,
          total_cost: 4000,
        }),
      ),
    ]);
    // one fully-incoming C → 2 points → Acceptable.
    expect(acceptable[0]!.tier).toBe('Acceptable');
    expect(acceptable[0]!.sell_through_pct).toBeNull(); // nothing received
  });
});

// ── delivery metrics, rename alias, reasons, aged value buckets ─────

import { agedValueBuckets, daysBetween, percentile } from '../src/po-scoring';

describe('delivery metrics', () => {
  it('computes ETA slip, on_time and realized lead time from the PO dates', () => {
    const r = scorePo(
      po({
        po_number: 'PO-D1', supplier: 'S',
        ordered_date: '2026-01-01', original_eta: '2026-02-01', latest_eta: '2026-02-15',
        units_total: 10, units_in_stock: 5, units_sold: 5, total_cost: 1000, sold_cost: 500, sold_revenue: 900,
      }),
    );
    expect(r.eta_slip_days).toBe(14);
    expect(r.on_time).toBe(false);
    expect(r.realized_lead_time_days).toBe(45);
    expect(r.reasons.some((x) => x.code === 'SUPPLIER_LATE')).toBe(true);
  });

  it('keeps delivery fields null when dates are missing or nothing landed', () => {
    const noDates = scorePo(
      po({ po_number: 'PO-D2', supplier: 'S', ordered_date: null, original_eta: null, latest_eta: null, units_total: 10, units_in_stock: 4, units_sold: 6 }),
    );
    expect(noDates.eta_slip_days).toBeNull();
    expect(noDates.on_time).toBeNull();
    expect(noDates.realized_lead_time_days).toBeNull();
    const incoming = scorePo(
      po({ po_number: 'PO-D3', supplier: 'S', units_total: 10, units_incoming: 10 }),
    );
    expect(incoming.realized_lead_time_days).toBeNull();
    expect(incoming.reasons.map((x) => x.code)).toContain('STILL_INCOMING');
  });

  it('margin_per_landed_dollar equals the deprecated gmroi alias', () => {
    const r = scorePo(
      po({ po_number: 'PO-D4', supplier: 'S', units_total: 10, units_in_stock: 2, units_sold: 8, total_cost: 1000, sold_cost: 800, sold_revenue: 1500 }),
    );
    expect(r.margin_per_landed_dollar).toBe(r.gmroi);
    expect(r.margin_per_landed_dollar).toBeCloseTo(0.7, 5);
  });

  it('daysBetween and percentile guard their edges', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween(null, '2026-01-31')).toBeNull();
    expect(daysBetween('garbage', '2026-01-31')).toBeNull();
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.9)).toBe(40);
  });
});

describe('rollupSuppliers delivery stats', () => {
  it('rolls OTIF, avg slip, lead-time percentiles and last PO date per supplier', () => {
    const rows: PoScored[] = [
      scorePo(po({ po_number: 'P1', supplier: 'S', ordered_date: '2026-01-01', original_eta: '2026-02-01', latest_eta: '2026-01-30', units_total: 10, units_in_stock: 5, units_sold: 5, total_cost: 100, sold_cost: 50, sold_revenue: 90 })),
      scorePo(po({ po_number: 'P2', supplier: 'S', ordered_date: '2026-03-01', original_eta: '2026-04-01', latest_eta: '2026-04-11', units_total: 10, units_in_stock: 5, units_sold: 5, total_cost: 100, sold_cost: 50, sold_revenue: 90 })),
    ];
    const [s] = rollupSuppliers(rows);
    expect(s!.otif_pct).toBe(50);
    expect(s!.avg_slip_days).toBeCloseTo(4, 5); // (-2 + 10) / 2
    expect(s!.lead_time_p50_days).toBe(29); // lead times 29 and 41 → p50 nearest-rank = 29
    expect(s!.lead_time_p90_days).toBe(41);
    expect(s!.last_po_date).toBe('2026-03-01');
  });
});

describe('agedValueBuckets', () => {
  it('splits in-stock landed value into 0-90 / 91-180 / 180+ and prices per unit', () => {
    const rows = [
      scorePo(po({ po_number: 'P1', supplier: 'S', units_total: 100, units_in_stock: 40, units_sold: 60, total_cost: 1000, unsold_over_90d: 15, unsold_over_180d: 5 })),
      scorePo(po({ po_number: 'P2', supplier: 'S', units_total: 10, units_in_stock: 10, unsold_over_90d: 0, unsold_over_180d: 0 })), // uncosted
    ];
    const b = agedValueBuckets(rows);
    // P1 per-unit cost 10: fresh 25 * 10 = 250, mid 10 * 10 = 100, old 5 * 10 = 50.
    expect(b.fresh_value).toBe(250);
    expect(b.aged_91_180_value).toBe(100);
    expect(b.aged_over_180_value).toBe(50);
    expect(b.fresh_units).toBe(35); // 25 costed + 10 uncosted-fresh
    expect(b.pct_value_aged_90d).toBeCloseTo(37.5, 5);
    expect(b.uncosted_units).toBe(10);
  });

  it('caps aged counts at in-stock and yields null share with no costed stock', () => {
    const b = agedValueBuckets([
      scorePo(po({ po_number: 'P3', supplier: 'S', units_total: 10, units_in_stock: 3, units_sold: 7, unsold_over_90d: 9, unsold_over_180d: 9 })),
    ]);
    expect(b.aged_over_180_units).toBe(3);
    expect(b.pct_value_aged_90d).toBeNull();
  });
});

// ── caller-supplied thresholds ──────────────────────────────────────────────

describe('PoScoringThresholds', () => {
  const reasonOf = (r: PoScored, code: string) => r.reasons.find((x) => x.code === code);

  // st 91.67%, margin per landed 0.88, 4 left in stock: A / reorder by default.
  const strong = po({
    po_number: 'PO-A', supplier: 'Supplier 1',
    units_total: 50, units_in_stock: 4, units_sold: 44, units_cancelled: 2,
    total_cost: 5000, sold_cost: 4400, sold_revenue: 8800,
  });
  // st 63.16%, margin per landed 0.30: C by default (under the 0.35 B bar).
  const nearB = po({
    po_number: 'PO-B', supplier: 'Supplier 1',
    units_total: 40, units_in_stock: 14, units_sold: 24, units_cancelled: 2,
    total_cost: 6000, sold_cost: 3600, sold_revenue: 5400,
  });
  // st 63.16%, margin per landed 0.42: B by default.
  const solid = po({
    po_number: 'PO-B2', supplier: 'Supplier 1',
    units_total: 40, units_in_stock: 14, units_sold: 24, units_cancelled: 2,
    total_cost: 4800, sold_cost: 3000, sold_revenue: 5000,
  });
  // st 86.21%, margin per landed 0.06: D by default, on margin alone.
  const thin = po({
    po_number: 'PO-THIN', supplier: 'Supplier 1',
    units_total: 60, units_in_stock: 8, units_sold: 50, units_cancelled: 2,
    total_cost: 9000, sold_cost: 7500, sold_revenue: 8000,
  });
  // st 35%, margin per landed 0.60, nothing aged: D / markdown by default, on sell-through alone.
  const slow = po({
    po_number: 'PO-SLOW', supplier: 'Supplier 1',
    units_total: 20, units_in_stock: 13, units_sold: 7,
    total_cost: 1000, sold_cost: 300, sold_revenue: 900,
  });
  // st 50%, margin per landed 0.40, 2 of 10 in stock aged (20%): C / markdown by default.
  const ageing = po({
    po_number: 'PO-AGE', supplier: 'Supplier 1',
    units_total: 20, units_in_stock: 10, units_sold: 10,
    total_cost: 1000, sold_cost: 500, sold_revenue: 900,
    unsold_over_90d: 2,
  });
  // 98 in stock, 2 sold: D / markdown once it is old enough to judge.
  const landed = (days: number) =>
    po({
      po_number: 'PO-NEW', supplier: 'Supplier 1',
      units_total: 100, units_in_stock: 98, units_sold: 2,
      total_cost: 4900, sold_cost: 100, sold_revenue: 120,
      oldest_unsold_days: days,
    });

  it('passing the defaults explicitly, or an empty object, scores the same as passing nothing', () => {
    for (const row of [strong, nearB, solid, thin, slow, ageing, landed(6), landed(90)]) {
      expect(scorePo(row, DEFAULT_PO_SCORING_THRESHOLDS)).toEqual(scorePo(row));
      expect(scorePo(row, {})).toEqual(scorePo(row));
    }
  });

  it('low_sell_through_pct moves the D / markdown line and the number in the reason text', () => {
    const byDefault = scorePo(slow);
    expect(byDefault.grade).toBe('D');
    expect(byDefault.signal).toBe('markdown');
    expect(reasonOf(byDefault, 'SELL_THROUGH_LOW')?.detail).toBe('sell-through 35% < 40%');

    const lower = scorePo(slow, { low_sell_through_pct: 30 });
    expect(lower.grade).toBe('C');
    expect(lower.rag).toBe('amber');
    expect(lower.signal).toBe('watch');
    expect(reasonOf(lower, 'SELL_THROUGH_LOW')).toBeUndefined();

    const tighter = scorePo(slow, { low_sell_through_pct: 36 });
    expect(tighter.grade).toBe('D');
    expect(reasonOf(tighter, 'SELL_THROUGH_LOW')?.detail).toBe('sell-through 35% < 36%');
  });

  it('low_margin_per_landed moves the D line, and the reason text carries no currency symbol', () => {
    const byDefault = scorePo(thin);
    expect(byDefault.grade).toBe('D');
    expect(reasonOf(byDefault, 'MARGIN_PER_DOLLAR_LOW')?.detail).toBe('margin 0.06 per 1.00 landed < 0.20');

    const lower = scorePo(thin, { low_margin_per_landed: 0.05 });
    expect(lower.grade).toBe('C');
    expect(lower.rag).toBe('amber');
    expect(reasonOf(lower, 'MARGIN_PER_DOLLAR_LOW')).toBeUndefined();

    const tighter = scorePo(thin, { low_margin_per_landed: 0.1 });
    expect(tighter.grade).toBe('D');
    expect(reasonOf(tighter, 'MARGIN_PER_DOLLAR_LOW')?.detail).toBe('margin 0.06 per 1.00 landed < 0.10');
  });

  it('strong_sell_through_pct raises the A and reorder bar', () => {
    const r = scorePo(strong, { strong_sell_through_pct: 95 });
    expect(r.grade).toBe('B');
    expect(r.rag).toBe('green');
    expect(r.signal).toBe('watch');
    expect(reasonOf(r, 'SELL_THROUGH_STRONG')).toBeUndefined();
    expect(reasonOf(scorePo(strong), 'SELL_THROUGH_STRONG')?.detail).toBe('sell-through 92% of received');
  });

  it('strong_margin_per_landed raises the A and reorder bar', () => {
    const r = scorePo(strong, { strong_margin_per_landed: 0.9 });
    expect(r.grade).toBe('B');
    expect(r.signal).toBe('watch');
  });

  it('solid_sell_through_pct raises the B bar', () => {
    const r = scorePo(solid, { solid_sell_through_pct: 65 });
    expect(r.grade).toBe('C');
    expect(r.rag).toBe('amber');
  });

  it('solid_margin_per_landed lowers the B bar', () => {
    const r = scorePo(nearB, { solid_margin_per_landed: 0.3 });
    expect(r.grade).toBe('B');
    expect(r.rag).toBe('green');
  });

  it('reorder_in_stock_max decides how little stock a reorder signal needs', () => {
    const byDefault = scorePo(strong);
    expect(byDefault.signal).toBe('reorder');
    expect(reasonOf(byDefault, 'STOCK_NEARLY_GONE')?.detail).toBe('4 units left in stock');

    const r = scorePo(strong, { reorder_in_stock_max: 3 });
    expect(r.grade).toBe('A');
    expect(r.signal).toBe('watch');
    expect(reasonOf(r, 'STOCK_NEARLY_GONE')).toBeUndefined();
  });

  it('aged_share_high_pct moves the aged-share markdown line', () => {
    const byDefault = scorePo(ageing);
    expect(byDefault.grade).toBe('C');
    expect(byDefault.signal).toBe('markdown');
    expect(reasonOf(byDefault, 'AGED_STOCK_SHARE_HIGH')?.value).toBe(20);

    const r = scorePo(ageing, { aged_share_high_pct: 25 });
    expect(r.grade).toBe('C');
    expect(r.signal).toBe('watch');
    expect(reasonOf(r, 'AGED_STOCK_SHARE_HIGH')).toBeUndefined();
  });

  it('supplier_late_days decides which ETA slip is reported late', () => {
    // ETA slipped 14 days.
    const slipped = po({
      po_number: 'PO-LATE', supplier: 'Supplier 1',
      original_eta: '2026-02-01', latest_eta: '2026-02-15',
      units_total: 10, units_in_stock: 5, units_sold: 5, total_cost: 1000, sold_cost: 500, sold_revenue: 900,
    });
    expect(reasonOf(scorePo(slipped), 'SUPPLIER_LATE')?.value).toBe(14);
    expect(reasonOf(scorePo(slipped, { supplier_late_days: 14 }), 'SUPPLIER_LATE')).toBeUndefined();
    expect(reasonOf(scorePo(slipped, { supplier_late_days: 13 }), 'SUPPLIER_LATE')?.value).toBe(14);
  });

  it('judge_min_days sets the too-early window and the number in its reason text', () => {
    const shorter = scorePo(landed(6), { judge_min_days: 5 });
    expect(shorter.grade).toBe('D');
    expect(shorter.signal).toBe('markdown');
    expect(reasonOf(shorter, 'TOO_EARLY_TO_JUDGE')).toBeUndefined();

    const longer = scorePo(landed(90), { judge_min_days: 120 });
    expect(longer.grade).toBe('C');
    expect(longer.signal).toBe('watch');
    expect(reasonOf(longer, 'TOO_EARLY_TO_JUDGE')?.detail).toBe(
      'stock landed 90 days ago (< 120) - too early to judge sell-through',
    );
    expect(reasonOf(scorePo(landed(6)), 'TOO_EARLY_TO_JUDGE')?.detail).toBe(
      'stock landed 6 days ago (< 60) - too early to judge sell-through',
    );
  });

  it('the tier cut-offs move a supplier between tiers', () => {
    // One A (4 points) and one D (1 point): average 2.5, Acceptable by default.
    const rows = [scorePo(strong), scorePo(thin)];
    expect(rollupSuppliers(rows)[0]!.tier).toBe('Acceptable');
    expect(rollupSuppliers(rows, DEFAULT_PO_SCORING_THRESHOLDS)[0]!.tier).toBe('Acceptable');
    expect(rollupSuppliers(rows, { tier_acceptable_min_points: 2.6 })[0]!.tier).toBe('At risk');
    expect(rollupSuppliers(rows, { tier_strong_min_points: 2.5 })[0]!.tier).toBe('Strong');
    expect(rollupSuppliers(rows, { tier_preferred_min_points: 2.5 })[0]!.tier).toBe('Preferred');
  });

  it('rollupSuppliers tiers on the grades already on the rows, so scorePo thresholds carry through', () => {
    // With the margin floor at 0.05 the thin PO grades C: A (4) + C (2) = 3.0, Strong.
    const rows = [scorePo(strong), scorePo(thin, { low_margin_per_landed: 0.05 })];
    expect(rollupSuppliers(rows)[0]!.tier).toBe('Strong');
  });
});
