import { describe, it, expect } from 'vitest';
import {
  realisedLeadTimes,
  type LeadTimeOrderLine,
  type LeadTimeReceipt,
} from '../src/lead-time';
import {
  type SkuStats,
  type BuyerSettings,
  DEFAULT_BUYER_SETTINGS,
  deriveSkuMetrics,
  resolveLeadTime,
  resolveLeadTimeDetail,
} from '../src/buyer-metrics';
import { buildBuyPlan, type BuyPlanRowInput } from '../src/buy-plan';

const AS_OF = '2026-06-30';

const line = (o: Partial<LeadTimeOrderLine> & { po_ref: string; ordered_on: string }): LeadTimeOrderLine => ({
  sku: 'AAA:0001',
  supplier_ref: 'SUP-1',
  line_ref: null,
  ...o,
});

const receipt = (o: Partial<LeadTimeReceipt> & { po_ref: string; received_on: string }): LeadTimeReceipt => ({
  sku: 'AAA:0001',
  line_ref: null,
  qty: 1,
  ...o,
});

describe('realisedLeadTimes: matching a receipt to its order line', () => {
  it('matches on po_ref + line_ref when both sides carry line_ref, whatever the sku says', () => {
    const r = realisedLeadTimes(
      [line({ po_ref: 'P1', line_ref: '1', sku: 'AAA:0001', ordered_on: '2026-05-01' })],
      [receipt({ po_ref: 'P1', line_ref: '1', sku: 'AAA:9999', received_on: '2026-05-06' })],
      { as_of: AS_OF },
    );
    expect(r['SUP-1']).toEqual({ median_days: 5, p90_days: 5, receipt_count: 1 });
  });

  it('matches on po_ref + sku when the receipts carry no line_ref', () => {
    const r = realisedLeadTimes(
      [line({ po_ref: 'P1', line_ref: '1', ordered_on: '2026-05-01' })],
      [receipt({ po_ref: 'P1', received_on: '2026-05-08' })],
      { as_of: AS_OF },
    );
    expect(r['SUP-1']).toEqual({ median_days: 7, p90_days: 7, receipt_count: 1 });
  });

  it('groups two order lines with the same key into one, from the earliest ordered_on', () => {
    const r = realisedLeadTimes(
      [
        line({ po_ref: 'P1', ordered_on: '2026-05-03' }),
        line({ po_ref: 'P1', ordered_on: '2026-05-01' }),
      ],
      [receipt({ po_ref: 'P1', received_on: '2026-05-05' })],
      { as_of: AS_OF },
    );
    expect(r['SUP-1']).toEqual({ median_days: 4, p90_days: 4, receipt_count: 1 });
  });

  it('measures to the first receipt with a positive quantity', () => {
    const r = realisedLeadTimes(
      [line({ po_ref: 'P1', ordered_on: '2026-05-01' })],
      [
        receipt({ po_ref: 'P1', received_on: '2026-05-02', qty: 0 }),
        receipt({ po_ref: 'P1', received_on: '2026-05-10', qty: 2 }),
        receipt({ po_ref: 'P1', received_on: '2026-05-04', qty: 1 }),
      ],
      { as_of: AS_OF },
    );
    expect(r['SUP-1']).toEqual({ median_days: 3, p90_days: 3, receipt_count: 1 });
  });

  it('compares po_ref as given: a different spelling of the same order does not match', () => {
    const r = realisedLeadTimes(
      [line({ po_ref: '00123', ordered_on: '2026-05-01' })],
      [receipt({ po_ref: '123', received_on: '2026-05-05' })],
      { as_of: AS_OF },
    );
    expect(r['SUP-1']).toBeUndefined();
  });
});

describe('realisedLeadTimes: which lines count', () => {
  it('drops a same-day receipt, a negative one and one over max_days; keeps exactly 1 and exactly max_days', () => {
    const r = realisedLeadTimes(
      [
        line({ po_ref: 'SAME', ordered_on: '2026-05-01' }),
        line({ po_ref: 'NEG', ordered_on: '2026-05-10' }),
        line({ po_ref: 'OVER', ordered_on: '2026-01-01' }),
        line({ po_ref: 'ONE', ordered_on: '2026-05-01' }),
        line({ po_ref: 'MAX', ordered_on: '2026-01-01' }),
      ],
      [
        receipt({ po_ref: 'SAME', received_on: '2026-05-01' }),
        receipt({ po_ref: 'NEG', received_on: '2026-05-08' }),
        receipt({ po_ref: 'OVER', received_on: '2026-03-03' }),
        receipt({ po_ref: 'ONE', received_on: '2026-05-02' }),
        receipt({ po_ref: 'MAX', received_on: '2026-03-02' }),
      ],
      { as_of: AS_OF, max_days: 60 },
    );
    expect(r['SUP-1']).toEqual({ median_days: 1, p90_days: 60, receipt_count: 2 });
  });

  it('counts only lines ordered inside the window, which counts back from as_of in calendar months', () => {
    const r = realisedLeadTimes(
      [
        line({ po_ref: 'BEFORE', ordered_on: '2026-03-29' }),
        line({ po_ref: 'START', ordered_on: '2026-03-30' }),
        line({ po_ref: 'AFTER', ordered_on: '2026-07-01' }),
      ],
      [
        receipt({ po_ref: 'BEFORE', received_on: '2026-04-01' }),
        receipt({ po_ref: 'START', received_on: '2026-04-02' }),
        receipt({ po_ref: 'AFTER', received_on: '2026-07-05' }),
      ],
      { as_of: AS_OF, window_months: 3 },
    );
    expect(r['SUP-1']).toEqual({ median_days: 3, p90_days: 3, receipt_count: 1 });
  });

  it('clamps the window start to the last day of a shorter month', () => {
    const r = realisedLeadTimes(
      [
        line({ po_ref: 'BEFORE', ordered_on: '2026-02-27' }),
        line({ po_ref: 'START', ordered_on: '2026-02-28' }),
      ],
      [
        receipt({ po_ref: 'BEFORE', received_on: '2026-03-03' }),
        receipt({ po_ref: 'START', received_on: '2026-03-04' }),
      ],
      { as_of: '2026-05-31', window_months: 3 },
    );
    expect(r['SUP-1']).toEqual({ median_days: 4, p90_days: 4, receipt_count: 1 });
  });

  it('defaults to a 12-month window and a 180-day cap', () => {
    const r = realisedLeadTimes(
      [
        line({ po_ref: 'OLD', ordered_on: '2025-06-29' }),
        line({ po_ref: 'IN', ordered_on: '2025-06-30' }),
        line({ po_ref: 'LONG', ordered_on: '2025-07-01' }),
      ],
      [
        receipt({ po_ref: 'OLD', received_on: '2025-07-01' }),
        receipt({ po_ref: 'IN', received_on: '2025-12-27' }),
        receipt({ po_ref: 'LONG', received_on: '2025-12-29' }),
      ],
      { as_of: AS_OF },
    );
    expect(r['SUP-1']).toEqual({ median_days: 180, p90_days: 180, receipt_count: 1 });
  });

  it('leaves out a supplier with no kept line', () => {
    const r = realisedLeadTimes(
      [line({ po_ref: 'P1', supplier_ref: 'SUP-2', ordered_on: '2026-05-01' })],
      [receipt({ po_ref: 'P1', received_on: '2026-05-01' })],
      { as_of: AS_OF },
    );
    expect(r).toEqual({});
  });
});

describe('realisedLeadTimes: the figures', () => {
  it('returns nearest-rank median and 90th percentile as whole days, the lower middle value for an even count', () => {
    const days = [2, 4, 6, 8];
    const r = realisedLeadTimes(
      days.map((_, i) => line({ po_ref: `P${i}`, ordered_on: '2026-05-01' })),
      days.map((d, i) => receipt({ po_ref: `P${i}`, received_on: `2026-05-${String(1 + d).padStart(2, '0')}` })),
      { as_of: AS_OF },
    );
    expect(r['SUP-1']).toEqual({ median_days: 4, p90_days: 8, receipt_count: 4 });
  });

  it('keeps suppliers apart', () => {
    const r = realisedLeadTimes(
      [
        line({ po_ref: 'P1', supplier_ref: 'SUP-1', ordered_on: '2026-05-01' }),
        line({ po_ref: 'P2', supplier_ref: 'SUP-2', ordered_on: '2026-05-01' }),
      ],
      [
        receipt({ po_ref: 'P1', received_on: '2026-05-03' }),
        receipt({ po_ref: 'P2', received_on: '2026-05-11' }),
      ],
      { as_of: AS_OF },
    );
    expect(r).toEqual({
      'SUP-1': { median_days: 2, p90_days: 2, receipt_count: 1 },
      'SUP-2': { median_days: 10, p90_days: 10, receipt_count: 1 },
    });
  });
});

describe('resolveLeadTimeDetail: a person\'s override first, then the data, then the default', () => {
  const settings: BuyerSettings = {
    ...DEFAULT_BUYER_SETTINGS,
    supplier_lead_time_overrides: { 'SUP-1': 21 },
    brand_lead_time_overrides: { AAA: 30 },
    class_lead_time_overrides: { ClassX: 40 },
  };
  const all = {
    brand: 'AAA',
    class_1: 'ClassX',
    sku: 'AAA:0001',
    supplier_ref: 'SUP-1',
    stock_lead_time_days: 9,
    supplier_lead_time_days: 11,
    lead_time_realised_median_days: 6,
    lead_time_realised_p90_days: 10,
    lead_time_receipt_count: 25,
  };

  it('a supplier override beats everything, including a measured figure', () => {
    expect(resolveLeadTimeDetail(settings, all)).toEqual({ days: 21, source: 'supplier_override' });
  });

  it('then the brand override, then the class override', () => {
    expect(resolveLeadTimeDetail(settings, { ...all, supplier_ref: 'SUP-9' })).toEqual({ days: 30, source: 'brand_override' });
    expect(resolveLeadTimeDetail(settings, { ...all, supplier_ref: 'SUP-9', brand: 'BBB', sku: 'BBB:0001' })).toEqual({
      days: 40,
      source: 'class_override',
    });
  });

  it('with no override: the SKU\'s own lead time, then the supplier\'s, then the measured figure, then the default', () => {
    const none = { ...all, supplier_ref: 'SUP-9', brand: 'BBB', sku: 'BBB:0001', class_1: 'ClassY' };
    expect(resolveLeadTimeDetail(DEFAULT_BUYER_SETTINGS, none)).toEqual({ days: 9, source: 'stock' });
    expect(resolveLeadTimeDetail(DEFAULT_BUYER_SETTINGS, { ...none, stock_lead_time_days: null })).toEqual({
      days: 11,
      source: 'supplier',
    });
    expect(
      resolveLeadTimeDetail(DEFAULT_BUYER_SETTINGS, { ...none, stock_lead_time_days: null, supplier_lead_time_days: null }),
    ).toEqual({ days: 6, source: 'realised', receipt_count: 25 });
    expect(
      resolveLeadTimeDetail(DEFAULT_BUYER_SETTINGS, {
        ...none,
        stock_lead_time_days: null,
        supplier_lead_time_days: null,
        lead_time_realised_median_days: null,
        lead_time_realised_p90_days: null,
        lead_time_receipt_count: 0,
      }),
    ).toEqual({ days: 14, source: 'default' });
  });

  it('a source lead time of 0 is not set', () => {
    const r = resolveLeadTimeDetail(DEFAULT_BUYER_SETTINGS, {
      brand: 'BBB',
      stock_lead_time_days: 0,
      supplier_lead_time_days: 0,
    });
    expect(r).toEqual({ days: 14, source: 'default' });
  });

  it('a measured figure is used only from lead_time_min_receipts kept lines (default 20)', () => {
    const measured = { brand: 'BBB', lead_time_realised_median_days: 6, lead_time_realised_p90_days: 10 };
    expect(resolveLeadTimeDetail(DEFAULT_BUYER_SETTINGS, { ...measured, lead_time_receipt_count: 19 })).toEqual({
      days: 14,
      source: 'default',
    });
    expect(resolveLeadTimeDetail(DEFAULT_BUYER_SETTINGS, { ...measured, lead_time_receipt_count: 20 })).toEqual({
      days: 6,
      source: 'realised',
      receipt_count: 20,
    });
    expect(
      resolveLeadTimeDetail({ ...DEFAULT_BUYER_SETTINGS, lead_time_min_receipts: 5 }, { ...measured, lead_time_receipt_count: 5 }),
    ).toEqual({ days: 6, source: 'realised', receipt_count: 5 });
  });

  it('lead_time_planning_quantile 0.9 sizes on the 90th percentile', () => {
    const measured = { brand: 'BBB', lead_time_realised_median_days: 6, lead_time_realised_p90_days: 10, lead_time_receipt_count: 30 };
    expect(resolveLeadTimeDetail({ ...DEFAULT_BUYER_SETTINGS, lead_time_planning_quantile: 0.9 }, measured)).toEqual({
      days: 10,
      source: 'realised',
      receipt_count: 30,
    });
  });

  it('resolveLeadTime returns the same days and keeps its old four-argument form', () => {
    expect(resolveLeadTime(settings, 'AAA', 'ClassX', 'AAA:0001', all)).toBe(21);
    expect(resolveLeadTime(DEFAULT_BUYER_SETTINGS, 'BBB', 'ClassY', 'BBB:0001')).toBe(14);
  });
});

describe('deriveSkuMetrics uses the resolved lead time', () => {
  const base: SkuStats = {
    sku: 'BBB:0001',
    brand: 'BBB',
    class_1: 'ClassY',
    category: 'ClassY',
    rrp: 100,
    unit_cost: 50,
    qty: 10,
    incoming: 0,
    age_of_oldest_item_days: 30,
    avg_daily_sales_30d: 2,
    avg_daily_sales_30_90d: 2,
    avg_daily_sales_90_180d: 2,
    avg_daily_sales_180_270d: 2,
    avg_daily_sales_270_360d: 2,
    avg_daily_sales_all_time: 2,
    avg_sale_price_30d: 95,
    avg_sale_price_30_90d: 95,
    avg_sale_price_90_180d: 95,
    avg_sale_price_all_time: 95,
  };

  it('a measured lead time from enough receipts reaches lead_time_days', () => {
    const d = deriveSkuMetrics(
      { ...base, lead_time_realised_median_days: 6, lead_time_realised_p90_days: 10, lead_time_receipt_count: 40 },
      DEFAULT_BUYER_SETTINGS,
      0,
    );
    expect(d.lead_time_days).toBe(6);
  });
});

describe('today\'s behaviour is the default: the same SKU set gives the same buy plan', () => {
  const sku = (n: number, over: Partial<SkuStats> = {}): SkuStats => ({
    sku: `CCC:${String(n).padStart(4, '0')}`,
    brand: 'CCC',
    class_1: 'ClassZ',
    category: 'ClassZ',
    rrp: 80,
    unit_cost: 40,
    qty: n,
    incoming: 0,
    age_of_oldest_item_days: 20,
    avg_daily_sales_30d: 1.5,
    avg_daily_sales_30_90d: 1.2,
    avg_daily_sales_90_180d: 1,
    avg_daily_sales_180_270d: 1,
    avg_daily_sales_270_360d: 1,
    avg_daily_sales_all_time: 1.1,
    avg_sale_price_30d: 75,
    avg_sale_price_30_90d: 76,
    avg_sale_price_90_180d: 77,
    avg_sale_price_all_time: 76,
    ...over,
  });
  const SET = [sku(0), sku(5), sku(12), sku(40)];

  const plan = (rows: SkuStats[], settings: BuyerSettings) =>
    buildBuyPlan({
      rows: rows.map(
        (s): BuyPlanRowInput => ({
          sku: s.sku,
          name: s.sku,
          status: 'active',
          brand: s.brand,
          stats: s,
          derived: deriveSkuMetrics(s, settings, 0),
          reasons: [],
          label: null,
          has_ad_spend: false,
        }),
      ),
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      handling_cost_per_line: settings.handling_cost_per_line,
    });

  it('with no lead-time data every SKU plans on the 14-day default', () => {
    for (const s of SET) expect(deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0).lead_time_days).toBe(14);
  });

  it('settings without the new keys, and SKUs whose new lead-time facts are empty or below the receipt minimum, give the same plan', () => {
    const oldShape = { ...DEFAULT_BUYER_SETTINGS } as Record<string, unknown>;
    delete oldShape.supplier_lead_time_overrides;
    delete oldShape.lead_time_min_receipts;
    delete oldShape.lead_time_planning_quantile;
    const before = plan(SET, oldShape as unknown as BuyerSettings);
    const empty = SET.map((s) => ({
      ...s,
      supplier_ref: null,
      stock_lead_time_days: null,
      supplier_lead_time_days: 0,
      lead_time_realised_median_days: 3,
      lead_time_realised_p90_days: 5,
      lead_time_receipt_count: 19,
    }));
    expect(plan(empty, DEFAULT_BUYER_SETTINGS)).toEqual(before);
    expect(before.lines.length).toBeGreaterThan(0);
  });
});
