/**
 * Buy rules: new products buy a trial quantity, slow sellers keep a small
 * fixed stock, and no line takes stock past max_cover_days of demand.
 */
import { describe, it, expect } from 'vitest';
import {
  applyBuyRules,
  isNewSku,
  newSkusNotSelling,
  overbuyOnOrder,
  DEFAULT_BUY_RULE_SETTINGS,
  type BuyRuleInput,
  type RuleRow,
} from '../src/buy-rules';
import { deriveSkuMetrics, skuReasons, DEFAULT_BUYER_SETTINGS, type SkuStats } from '../src/buyer-metrics';

function stats(over: Partial<SkuStats> = {}): SkuStats {
  return {
    sku: 'PPC:TEST-1',
    brand: 'PPC',
    class_1: 'CLASS_Q',
    category: 'Tools',
    rrp: 20,
    unit_cost: 8,
    qty: 0,
    incoming: 0,
    age_of_oldest_item_days: 200,
    avg_daily_sales_30d: 1,
    avg_daily_sales_30_90d: 1,
    avg_daily_sales_90_180d: 1,
    avg_daily_sales_180_270d: 1,
    avg_daily_sales_270_360d: 1,
    avg_daily_sales_all_time: 1,
    avg_sale_price_30d: 20,
    avg_sale_price_30_90d: 20,
    avg_sale_price_90_180d: 20,
    avg_sale_price_all_time: 20,
    ...over,
  };
}
/** A product that only started selling in the last 90 days. */
const fresh = (over: Partial<SkuStats> = {}) =>
  stats({ avg_daily_sales_90_180d: 0, avg_daily_sales_180_270d: 0, avg_daily_sales_270_360d: 0, age_of_oldest_item_days: 30, ...over });

const input = (over: Partial<BuyRuleInput> = {}): BuyRuleInput => ({
  qty: 10,
  stats: stats(),
  incoming_next_2m: 0,
  monthly_demand: 30,
  cover_demand_units: 120,
  selling: true,
  has_history: true,
  seasonal_class: false,
  settings: DEFAULT_BUY_RULE_SETTINGS,
  ...over,
});

describe('isNewSku', () => {
  it('is new with no sales 90-360 days ago and all stock under 180 days old', () => {
    expect(isNewSku(fresh())).toBe(true);
    expect(isNewSku(fresh({ age_of_oldest_item_days: 181 }))).toBe(false);
    expect(isNewSku(stats())).toBe(false);
  });
  it('counts a sold-out new product (no stock, no age) as new', () => {
    expect(isNewSku(fresh({ qty: 0, age_of_oldest_item_days: null }))).toBe(true);
  });
});

describe('applyBuyRules', () => {
  it('a slow seller keeps the stock target, and the rule never raises a line', () => {
    const slow = applyBuyRules(input({ qty: 6, monthly_demand: 0.5, cover_demand_units: 2 }));
    expect(slow).toMatchObject({ qty: 2, slow_seller: true });
    expect(applyBuyRules(input({ qty: 1, monthly_demand: 0.5 })).qty).toBe(1);
    expect(applyBuyRules(input({ qty: 6, monthly_demand: 0.5, stats: stats({ qty: 2 }) })).qty).toBe(0);
  });
  it('a new product is capped at the trial quantity, or at what it sold in the last 30 days if more', () => {
    expect(applyBuyRules(input({ qty: 40, stats: fresh({ avg_daily_sales_30d: 0.05 }) }))).toMatchObject({ qty: 3, trial_capped: true, new_sku: true });
    expect(applyBuyRules(input({ qty: 40, stats: fresh({ avg_daily_sales_30d: 0.5 }) })).qty).toBe(15);
  });
  it('caps stock + inbound + buy at max_cover_days of demand', () => {
    const r = applyBuyRules(input({ qty: 100, cover_demand_units: 60, stats: stats({ qty: 15 }), incoming_next_2m: 5 }));
    expect(r).toMatchObject({ qty: 40, cover_capped: true, pre_rule_qty: 100 });
  });
  it('leaves seasonal classes alone and each rule switches off at 0', () => {
    const big = input({ qty: 500, monthly_demand: 0.5, cover_demand_units: 10, stats: fresh() });
    expect(applyBuyRules({ ...big, seasonal_class: true }).qty).toBe(500);
    const off = { ...DEFAULT_BUY_RULE_SETTINGS, max_cover_days: 0, slow_seller_monthly_units: 0, new_sku_trial_qty: 0 };
    expect(applyBuyRules({ ...big, settings: off }).qty).toBe(500);
  });
});

describe('deriveSkuMetrics with buy rules', () => {
  it('stops the EOQ raising a cheap slow seller to a handful', () => {
    // ~0.6 sales/month, $2 unit cost, out of stock: EOQ alone raises the line.
    const slowStats = stats({ unit_cost: 2, avg_daily_sales_30d: 0.02, avg_daily_sales_30_90d: 0.02, avg_daily_sales_90_180d: 0.02 });
    const off = deriveSkuMetrics(slowStats, { ...DEFAULT_BUYER_SETTINGS, slow_seller_monthly_units: 0, max_cover_days: 0 }, 0);
    expect(off.suggested_buy_qty).toBeGreaterThan(2);
    const on = deriveSkuMetrics(slowStats, DEFAULT_BUYER_SETTINGS, 0);
    expect(on.slow_seller).toBe(true);
    expect(on.suggested_buy_qty).toBe(2);
    expect(skuReasons(on, slowStats, DEFAULT_BUYER_SETTINGS).map((x) => x.code)).toContain('SLOW_SELLER_MINMAX');
  });
  it('trial-caps a new product and says so', () => {
    const s = fresh({ avg_daily_sales_30d: 0.3, avg_daily_sales_30_90d: 0 });
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0);
    expect(d.new_sku).toBe(true);
    expect(d.trial_capped).toBe(true);
    expect(d.suggested_buy_qty).toBe(9);
    expect(skuReasons(d, s, DEFAULT_BUYER_SETTINGS).map((x) => x.code)).toContain('NEW_SKU_TRIAL');
  });
  it('cuts an EOQ batch back to max_cover_days', () => {
    const s = stats({ unit_cost: 1 });
    const cheapHolding = { ...DEFAULT_BUYER_SETTINGS, holding_rate_annual: 0.05 };
    expect(deriveSkuMetrics(s, { ...cheapHolding, max_cover_days: 0 }, 0).suggested_buy_qty).toBe(180);
    const d = deriveSkuMetrics(s, cheapHolding, 0);
    expect(d).toMatchObject({ suggested_buy_qty: 120, cover_capped: true });
    expect(skuReasons(d, s, cheapHolding).map((x) => x.code)).toContain('COVER_CAPPED');
  });
});

const row = (sku: string, s: SkuStats, coverUnits: number): RuleRow & { status: string; derived: Record<string, unknown> } => ({
  sku,
  status: 'active',
  stats: s,
  derived: { new_sku: isNewSku(s), cover_demand_units: coverUnits, seasonal_class: false, stockout_risk: 'Low', is_dead: false, weighted_velocity: 0, saleability: 'IN_STOCK', mp_only_selling: false },
});

describe('buy-rule exceptions', () => {
  it('NEW_SKU_SLOW lists new products under 25% sold after the review window', () => {
    const rows = [
      row('NEW-SLOW', fresh({ qty: 20, age_of_oldest_item_days: 60, avg_daily_sales_30d: 0.03, avg_daily_sales_30_90d: 0 }), 10),
      row('NEW-OK', fresh({ qty: 5, age_of_oldest_item_days: 60, avg_daily_sales_30d: 0.5 }), 10),
      row('NEW-YOUNG', fresh({ qty: 20, age_of_oldest_item_days: 20, avg_daily_sales_30d: 0 }), 10),
    ];
    expect(newSkusNotSelling(rows, DEFAULT_BUY_RULE_SETTINGS)).toEqual([{ sku: 'NEW-SLOW', units: 20, cost: 160 }]);
  });
  it('OVERBUY_ON_ORDER lists established SKUs whose stock + open POs run past the cover cap', () => {
    const rows = [row('DEEP', stats({ qty: 30, incoming: 200 }), 120), row('FINE', stats({ qty: 30, incoming: 50 }), 120)];
    expect(overbuyOnOrder(rows, DEFAULT_BUY_RULE_SETTINGS)).toEqual([{ sku: 'DEEP', units: 110, cost: 880 }]);
  });
});
