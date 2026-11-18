import { describe, it, expect } from 'vitest';
import { classifyPerformance, DEFAULT_PERFORMANCE_OPTIONS, type PerformanceRow } from '../src/performance';
import { applyEoqLineQty, DEFAULT_BUYER_SETTINGS, resolveLabelRole } from '../src/buyer-metrics';
import { buildBuyPlan, type BuyPlanRowInput } from '../src/buy-plan';

/** An established seller: sales in every window, old stock, so neither dead nor new. */
const row = (sku: string, o: Partial<PerformanceRow> = {}): PerformanceRow => ({
  sku,
  class_1: 'CAT_A',
  units_sold: 10,
  gross_profit: 100,
  revenue: 300,
  qty: 5,
  stock_cost: 50,
  age_of_oldest_item_days: 400,
  avg_daily_sales_30d: 0.2,
  avg_daily_sales_30_90d: 0.2,
  avg_daily_sales_90_180d: 0.2,
  avg_daily_sales_180_270d: 0.2,
  avg_daily_sales_270_360d: 0.2,
  ...o,
});

const NO_SALES = {
  avg_daily_sales_30d: 0,
  avg_daily_sales_30_90d: 0,
  avg_daily_sales_90_180d: 0,
  avg_daily_sales_180_270d: 0,
  avg_daily_sales_270_360d: 0,
};
/** Sales only in the last 90 days and stock that arrived 30 days ago. */
const NEW = {
  age_of_oldest_item_days: 30,
  avg_daily_sales_90_180d: 0,
  avg_daily_sales_180_270d: 0,
  avg_daily_sales_270_360d: 0,
};

const tiers = (rows: PerformanceRow[], options?: Parameters<typeof classifyPerformance>[1]) =>
  classifyPerformance(rows, options).map((r) => r.tier);

describe('classifyPerformance with ad spend', () => {
  it('proven: enough units and gross profit pays the ad spend back', () => {
    const [r] = classifyPerformance([row('SKU-1', { ad_cost: 50 })]);
    expect(r!.tier).toBe('proven');
    expect(r!.role).toBe('priority');
    expect(r!.metrics.mode).toBe('ad');
    expect(r!.metrics.return_on_ad_spend).toBe(2);
    expect(r!.reasons).toEqual([
      { code: 'PERF_PROVEN', detail: 'gross profit 2 per 1.00 of ad spend (bar 1), 10 units', value: 2 },
    ]);
  });

  it('a return exactly on the bar is strong', () => {
    expect(tiers([row('SKU-1', { ad_cost: 100 })])).toEqual(['proven']);
  });

  it('promising: a strong return on one sale', () => {
    const [r] = classifyPerformance([row('SKU-1', { units_sold: 1, ad_cost: 50 })]);
    expect(r!.tier).toBe('promising');
    expect(r!.role).toBeNull();
    expect(r!.reasons[0]).toEqual({
      code: 'PERF_PROMISING',
      detail: 'gross profit 2 per 1.00 of ad spend (bar 1); evidence under the floor (1 units, floor 2)',
      value: 2,
    });
  });

  it('underperforming: enough units, gross profit under the ad spend, and the spend is flagged as waste', () => {
    const [r] = classifyPerformance([row('SKU-1', { gross_profit: 20, ad_cost: 50 })]);
    expect(r!.tier).toBe('underperforming');
    expect(r!.role).toBeNull();
    expect(r!.reasons).toEqual([
      {
        code: 'PERF_UNDERPERFORMING',
        detail: 'gross profit 0.4 per 1.00 of ad spend under the bar of 1, 10 units',
        value: 0.4,
      },
      { code: 'AD_WASTE', detail: 'ad spend 50 on an underperforming SKU', value: 50 },
    ]);
  });

  it('no_evidence: a weak return on one sale is not judged', () => {
    const [r] = classifyPerformance([row('SKU-1', { units_sold: 1, gross_profit: 20, ad_cost: 50 })]);
    expect(r!.tier).toBe('no_evidence');
    expect(r!.reasons).toEqual([{ code: 'PERF_NO_EVIDENCE', detail: 'not enough to judge: 1 units' }]);
  });

  it('the exposure floor applies only to rows that report exposure', () => {
    const rows = [
      row('SKU-1', { ad_cost: 50, exposure: 50 }),
      row('SKU-2', { ad_cost: 50, exposure: 150 }),
      row('SKU-3', { ad_cost: 50 }),
    ];
    expect(tiers(rows)).toEqual(['proven', 'proven', 'proven']);
    const floored = classifyPerformance(rows, { min_exposure: 100, exposure_kind: 'clicks' });
    expect(floored.map((r) => r.tier)).toEqual(['promising', 'proven', 'proven']);
    expect(floored[0]!.reasons[0]!.detail).toBe(
      'gross profit 2 per 1.00 of ad spend (bar 1); evidence under the floor (50 clicks, floor 100)',
    );
  });
});

describe('classifyPerformance without ad data', () => {
  const five = [10, 20, 30, 40, 50].map((gp, i) => row(`SKU-${i + 1}`, { gross_profit: gp }));

  it('ranks gross profit within the class: only the top fifth is proven', () => {
    const out = classifyPerformance(five);
    expect(out.map((r) => r.metrics.class_percentile)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(out.map((r) => r.tier)).toEqual(['no_evidence', 'no_evidence', 'no_evidence', 'no_evidence', 'proven']);
    expect(out[4]!.metrics.mode).toBe('rank');
    expect(out[4]!.metrics.return_on_ad_spend).toBeNull();
    expect(out[4]!.reasons).toEqual([
      { code: 'PERF_PROVEN', detail: 'gross profit 50 at the 100th percentile of its class, 10 units', value: 100 },
    ]);
  });

  it('promising: top of the class on one sale', () => {
    const rows = [row('SKU-1', { gross_profit: 10 }), row('SKU-2', { gross_profit: 50, units_sold: 1 })];
    expect(tiers(rows)).toEqual(['no_evidence', 'promising']);
  });

  it('underperforming: enough units and no gross profit, with no ad waste reason', () => {
    const [r] = classifyPerformance([row('SKU-1', { gross_profit: -5 }), row('SKU-2')]);
    expect(r!.tier).toBe('underperforming');
    expect(r!.reasons).toEqual([
      { code: 'PERF_UNDERPERFORMING', detail: 'gross profit -5 on 10 units', value: -5 },
    ]);
  });

  it('ranks each class on its own, and a class of one is its own top', () => {
    const rows = [
      row('SKU-1', { class_1: 'CAT_A', gross_profit: 500 }),
      row('SKU-2', { class_1: 'CAT_A', gross_profit: 400 }),
      row('SKU-3', { class_1: 'CAT_B', gross_profit: 5 }),
    ];
    const out = classifyPerformance(rows);
    expect(out.map((r) => r.metrics.class_percentile)).toEqual([1, 0, 1]);
    expect(out.map((r) => r.tier)).toEqual(['proven', 'no_evidence', 'proven']);
  });

  it('a class of one with no gross profit is not proven', () => {
    expect(tiers([row('SKU-1', { gross_profit: 0 })])).toEqual(['underperforming']);
  });

  it('rows with an empty, null or absent class rank together', () => {
    const rows = [
      row('SKU-1', { class_1: '', gross_profit: 10 }),
      row('SKU-2', { class_1: null, gross_profit: 20 }),
      row('SKU-3', { class_1: undefined, gross_profit: 30 }),
    ];
    expect(classifyPerformance(rows).map((r) => r.metrics.class_percentile)).toEqual([0, 0.5, 1]);
  });

  it('with no exposure and no ad data the tiers are these six and tested_no_sale is not one of them', () => {
    const rows = [
      row('SKU-1', { ...NO_SALES, gross_profit: 900 }), // stock, no sales
      row('SKU-2', { ...NEW, gross_profit: -50 }), // new, losing money
      row('SKU-3', { gross_profit: 800 }), // top of the class
      row('SKU-4', { gross_profit: 1000, units_sold: 1 }), // top, one sale
      row('SKU-5', { gross_profit: -10 }), // sells at a loss
      row('SKU-6', { gross_profit: 5, units_sold: 0, lifetime_units_sold: 0 }), // nothing to go on
    ];
    expect(tiers(rows)).toEqual(['run_down', 'new', 'no_evidence', 'promising', 'underperforming', 'no_evidence']);
    expect(tiers(rows, { priority_percentile: 0.6 })).toEqual([
      'run_down',
      'new',
      'proven',
      'promising',
      'underperforming',
      'no_evidence',
    ]);
  });
});

describe('classifyPerformance tier order', () => {
  it('a product with stock and no sales is run_down whatever its past return', () => {
    const [r] = classifyPerformance([row('SKU-1', { ...NO_SALES, gross_profit: 500, ad_cost: 10 })]);
    expect(r!.tier).toBe('run_down');
    expect(r!.role).toBe('run_down');
    expect(r!.reasons).toEqual([
      { code: 'DEAD_STOCK', detail: '5 units on hand, no sales across the velocity windows', value: 5 },
    ]);
  });

  it('a new product is new, not underperforming, even with enough units at a loss', () => {
    const [r] = classifyPerformance([row('SKU-1', { ...NEW, gross_profit: -40, ad_cost: 50 })]);
    expect(r!.tier).toBe('new');
    expect(r!.role).toBeNull();
    expect(r!.reasons).toEqual([{ code: 'NEW_SKU_TRIAL', detail: 'new or re-launched: not judged yet' }]);
  });

  it('new_sku_window_days decides how long a product stays new', () => {
    const rows = [row('SKU-1', { ...NEW, gross_profit: -40, ad_cost: 50 })];
    expect(tiers(rows, { new_sku_window_days: 20 })).toEqual(['underperforming']);
  });

  it('velocity_weights decide whether old sales alone keep a product from being run_down', () => {
    const rows = [row('SKU-1', { avg_daily_sales_30d: 0, avg_daily_sales_30_90d: 0, ad_cost: 50 })];
    expect(tiers(rows)).toEqual(['proven']);
    expect(tiers(rows, { velocity_weights: [0.5, 0.5, 0] })).toEqual(['run_down']);
  });

  it('a null stock cost is carried through and changes no tier', () => {
    const [r] = classifyPerformance([row('SKU-1', { stock_cost: null, ad_cost: 50 })]);
    expect(r!.tier).toBe('proven');
    expect(r!.metrics.stock_cost).toBeNull();
  });
});

describe('classifyPerformance tested_no_sale', () => {
  const shown = row('SKU-1', {
    units_sold: 0,
    gross_profit: 0,
    lifetime_units_sold: 0,
    lifetime_exposure: 5000,
  });

  it('never fires at the default options', () => {
    expect(tiers([shown, row('SKU-2')])).toEqual(['no_evidence', 'proven']);
  });

  it('fires once the caller sets tested_exposure, and names the exposure kind', () => {
    const [r] = classifyPerformance([shown, row('SKU-2')], { tested_exposure: 1000, exposure_kind: 'clicks' });
    expect(r!.tier).toBe('tested_no_sale');
    expect(r!.role).toBe('run_down');
    expect(r!.reasons).toEqual([{ code: 'PERF_TESTED_NO_SALE', detail: '5000 clicks and no sale', value: 5000 }]);
  });

  it('does not fire for a product that has sold, or one under the threshold', () => {
    const sold = { ...shown, sku: 'SKU-3', lifetime_units_sold: 1 };
    const thin = { ...shown, sku: 'SKU-4', lifetime_exposure: 999 };
    expect(tiers([sold, thin, row('SKU-2')], { tested_exposure: 1000 })).toEqual([
      'no_evidence',
      'no_evidence',
      'proven',
    ]);
  });
});

describe('classifyPerformance options', () => {
  it('min_units moves the evidence floor', () => {
    expect(tiers([row('SKU-1', { ad_cost: 50 })], { min_units: 20 })).toEqual(['promising']);
  });

  it('min_return_on_ad_spend moves the bar and the number in the reason', () => {
    const [r] = classifyPerformance([row('SKU-1', { ad_cost: 50 })], { min_return_on_ad_spend: 3 });
    expect(r!.tier).toBe('underperforming');
    expect(r!.reasons[0]!.detail).toBe('gross profit 2 per 1.00 of ad spend under the bar of 3, 10 units');
  });

  it('priority_percentile widens the proven share of a class', () => {
    const five = [10, 20, 30, 40, 50].map((gp, i) => row(`SKU-${i + 1}`, { gross_profit: gp }));
    expect(tiers(five, { priority_percentile: 0.5 })).toEqual([
      'no_evidence',
      'no_evidence',
      'proven',
      'proven',
      'proven',
    ]);
  });
});

describe('performance roles in the buy plan and the EOQ guard', () => {
  const planRow = (sku: string, o: Partial<BuyPlanRowInput> = {}): BuyPlanRowInput => ({
    sku,
    name: sku,
    brand: 'Brand F',
    stats: { unit_cost: 10, rrp: 30, qty: 0, class_1: 'CAT_A' },
    derived: {
      stockout_risk: 'STOCKOUT',
      reorder: true,
      suggested_buy_qty: 5,
      coverage_days: 0,
      forward_coverage_days: null,
      basis: 'trailing',
      coverage_target_days: 30,
      lead_time_days: 14,
      incoming_next_2m: 0,
      eoq_base_qty: 5,
      eoq_qty: 5,
      eoq_applied: false,
      eoq_annual_demand: 0,
      min_order_qty: null,
      min_applied: false,
      pack_qty: null,
      pack_applied: false,
      pre_pack_qty: 5,
    },
    reasons: [],
    ...o,
  });
  const plan = (rows: BuyPlanRowInput[], label_roles?: Record<string, 'priority' | 'run_down'>) =>
    buildBuyPlan({
      rows,
      brandBudgets: {},
      brandStockValue: {},
      supplierBySku: new Map(),
      budget_aware: false,
      ...(label_roles ? { label_roles } : {}),
    });
  const eoq = (ctx?: Parameters<typeof applyEoqLineQty>[0]['ctx']) =>
    applyEoqLineQty({
      baseQty: 1,
      velocity: 60 / 365,
      forward: null,
      unit_cost: 8,
      is_dead: false,
      settings: { eoq_enabled: true, handling_cost_per_line: 4, holding_rate_annual: 0.25, eoq_max_cover_days: 180 },
      ctx,
    });

  it('a proven product that is stocked out leads the plan, and a run_down one gets no EOQ top-up', () => {
    const tiered = classifyPerformance([
      row('SKU-1', { gross_profit: 10 }),
      row('SKU-2', { gross_profit: 50 }),
      row('SKU-3', { ...NO_SALES, gross_profit: 0 }),
    ]);
    expect(tiered.map((r) => r.role)).toEqual([null, 'priority', 'run_down']);

    const built = plan([planRow('SKU-1', { role: tiered[0]!.role }), planRow('SKU-2', { role: tiered[1]!.role })]);
    expect(built.lines.map((l) => l.sku)).toEqual(['SKU-2', 'SKU-1']);
    expect(built.lines[0]!.is_priority).toBe(true);
    expect(built.lines[0]!.reasons[0]).toEqual({
      code: 'PRIORITY_STOCKOUT',
      detail: 'stocked out, priority role - buy first',
    });

    expect(eoq().qty).toBe(15);
    const blocked = eoq({ role: tiered[2]!.role });
    expect(blocked.qty).toBe(1);
    expect(blocked.applied).toBe(false);
    expect(eoq({ role: tiered[1]!.role }).qty).toBe(15);
  });

  it("the caller's own label, mapped through label_roles, wins over the row's role", () => {
    const rows = [planRow('SKU-1'), planRow('SKU-2', { role: 'priority', label: 'LABEL_RUNDOWN' })];
    expect(plan(rows, { LABEL_RUNDOWN: 'run_down' }).lines.map((l) => l.is_priority)).toEqual([false, false]);
    // An unmapped label leaves the row's role in force.
    expect(plan(rows, { LABEL_OTHER: 'run_down' }).lines[0]!.sku).toBe('SKU-2');
    expect(resolveLabelRole('LABEL_RUNDOWN', { LABEL_RUNDOWN: 'run_down' }, 'priority')).toBe('run_down');
    expect(resolveLabelRole('LABEL_OTHER', { LABEL_RUNDOWN: 'run_down' }, 'priority')).toBe('priority');
    expect(resolveLabelRole(null, undefined, null)).toBeNull();
    expect(eoq({ role: 'run_down', label: 'LABEL_TOP', label_roles: { LABEL_TOP: 'priority' } }).qty).toBe(15);
  });
});

describe('classifyPerformance class rank details', () => {
  it('two rows tied at the top of a class of five are both proven', () => {
    const rows = [10, 20, 30, 50, 50].map((gp, i) => row(`SKU-${i + 1}`, { gross_profit: gp }));
    const out = classifyPerformance(rows);
    expect(out.map((r) => r.metrics.class_percentile)).toEqual([0, 0.25, 0.5, 0.88, 0.88]);
    expect(out.map((r) => r.tier)).toEqual(['no_evidence', 'no_evidence', 'no_evidence', 'proven', 'proven']);
  });

  it('the percentile in the reason reads as an ordinal: 1st, 2nd, 3rd, 11th, 21st', () => {
    // 101 rows with distinct gross profit: row i out-earns i of the other 100.
    const rows = Array.from({ length: 101 }, (_, i) => row(`SKU-${i}`, { gross_profit: i + 1 }));
    const out = classifyPerformance(rows, { priority_percentile: 0 });
    const ordinalAt = (i: number) => /at the (\d+[a-z]+) percentile/.exec(out[i]!.reasons[0]!.detail)?.[1];
    expect([0, 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 100].map(ordinalAt)).toEqual([
      '0th', '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '100th',
    ]);
  });

  it('a profitable mid-class row with enough units is not told it has too few units', () => {
    const five = [10, 20, 30, 40, 50].map((gp, i) => row(`SKU-${i + 1}`, { gross_profit: gp }));
    const [, , mid] = classifyPerformance(five);
    expect(mid!.tier).toBe('no_evidence');
    expect(mid!.reasons).toEqual([
      {
        code: 'PERF_NO_EVIDENCE',
        detail: 'gross profit 30 at the 50th percentile of its class, under the 80th that counts as strong; 10 units',
      },
    ]);
  });

  it('tested_no_sale also fires for a row with ad spend', () => {
    const shownWithAds = row('SKU-1', {
      units_sold: 0,
      gross_profit: 0,
      ad_cost: 50,
      lifetime_units_sold: 0,
      lifetime_exposure: 5000,
    });
    const [r] = classifyPerformance([shownWithAds], { tested_exposure: 1000 });
    expect(r!.metrics.mode).toBe('ad');
    expect(r!.tier).toBe('tested_no_sale');
    expect(r!.role).toBe('run_down');
  });

  it('the default velocity_weights are a copy: changing them leaves DEFAULT_BUYER_SETTINGS alone', () => {
    expect(DEFAULT_PERFORMANCE_OPTIONS.velocity_weights).toEqual(DEFAULT_BUYER_SETTINGS.velocity_weights);
    const weights = DEFAULT_PERFORMANCE_OPTIONS.velocity_weights as unknown as number[];
    const before = weights[0]!;
    try {
      weights[0] = 0.9;
      expect(DEFAULT_BUYER_SETTINGS.velocity_weights[0]).toBe(0.5);
    } finally {
      weights[0] = before;
    }
  });
});
