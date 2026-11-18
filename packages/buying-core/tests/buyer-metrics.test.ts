import { describe, it, expect } from 'vitest';
import {
  type SkuStats,
  type BuyerSettings,
  DEFAULT_BUYER_SETTINGS,
  weightedVelocity,
  coverageDays,
  coverageGap,
  profitabilityAdjust,
  resolveCoverageTarget,
  isDead,
  reorderFlag,
  trendPct,
  deriveSkuMetrics,
  compareByRisk,
  annualDemandUnits,
  economicOrderQty,
  applyEoqLineQty,
  EOQ_FALLBACK_UNIT_COST,
} from '../src/buyer-metrics';

/** A healthy mid-velocity SKU used as the baseline for the derive tests. */
function stats(over: Partial<SkuStats> = {}): SkuStats {
  return {
    sku: 'FFF:1001',
    brand: 'FFF',
    class_1: 'Accessories',
    category: 'Accessories',
    rrp: 150,
    unit_cost: 75,
    qty: 60,
    incoming: 0,
    age_of_oldest_item_days: 40,
    avg_daily_sales_30d: 2.0,
    avg_daily_sales_30_90d: 1.5,
    avg_daily_sales_90_180d: 1.0,
    avg_daily_sales_180_270d: 0.8,
    avg_daily_sales_270_360d: 0.9,
    avg_daily_sales_all_time: 1.2,
    avg_sale_price_30d: 139.0,
    avg_sale_price_30_90d: 142.5,
    avg_sale_price_90_180d: 145.0,
    avg_sale_price_all_time: 141.0,
    ...over,
  };
}

describe('weightedVelocity', () => {
  it('blends 30d (0.5), 30-90d (0.3), 90-180d (0.2)', () => {
    // 0.5*2 + 0.3*1.5 + 0.2*1 = 1 + 0.45 + 0.2 = 1.65
    expect(weightedVelocity(stats())).toBeCloseTo(1.65, 10);
  });

  it('is 0 when every window is 0', () => {
    expect(
      weightedVelocity({ avg_daily_sales_30d: 0, avg_daily_sales_30_90d: 0, avg_daily_sales_90_180d: 0 }),
    ).toBe(0);
  });

  it('tolerates a single-window seller', () => {
    expect(
      weightedVelocity({ avg_daily_sales_30d: 4, avg_daily_sales_30_90d: 0, avg_daily_sales_90_180d: 0 }),
    ).toBeCloseTo(2.0, 10);
  });
});

describe('coverageDays', () => {
  it('divides qty by velocity', () => {
    expect(coverageDays(60, 1.65)).toBeCloseTo(36.3636, 3);
  });

  it('guards div-0: null when velocity is 0 (never Infinity)', () => {
    expect(coverageDays(60, 0)).toBeNull();
  });

  it('clamps negative on-hand to 0 days, not negative coverage', () => {
    expect(coverageDays(-3, 2)).toBe(0);
  });
});

describe('coverageGap', () => {
  it('is target minus coverage', () => {
    expect(coverageGap(30, 12)).toBe(18);
    expect(coverageGap(30, 45)).toBe(-15);
  });

  it('is null when coverage is null (zero-velocity SKU)', () => {
    expect(coverageGap(30, null)).toBeNull();
  });
});

describe('profitabilityAdjust + resolveCoverageTarget', () => {
  const curve = DEFAULT_BUYER_SETTINGS.profitability_coverage_adjust;

  it('default curve: 1 → -15%, 2 → -30%, 3 → -50%', () => {
    expect(profitabilityAdjust(curve, 1)).toBe(-0.15);
    expect(profitabilityAdjust(curve, 2)).toBe(-0.3);
    expect(profitabilityAdjust(curve, 3)).toBe(-0.5);
  });

  it('levels >= 4 use the -100% entry (largest defined level <= the SKU level)', () => {
    expect(profitabilityAdjust(curve, 4)).toBe(-1);
    expect(profitabilityAdjust(curve, 7)).toBe(-1);
  });

  it('level 0 / unset → no adjustment', () => {
    expect(profitabilityAdjust(curve, 0)).toBe(0);
    expect(profitabilityAdjust(curve, undefined)).toBe(0);
  });

  it('clamps a mis-configured curve to [-1, 0] - the curve can only reduce coverage', () => {
    expect(profitabilityAdjust({ '1': 0.5 }, 1)).toBe(0);
    expect(profitabilityAdjust({ '1': -2 }, 1)).toBe(-1);
  });

  it('resolves the target: default 30d, brand override wins, adjust applies on top', () => {
    const s: BuyerSettings = {
      ...DEFAULT_BUYER_SETTINGS,
      brand_coverage_overrides: { FFF: 45 },
    };
    expect(resolveCoverageTarget(s, 'FFA', undefined)).toBe(30); // default
    expect(resolveCoverageTarget(s, 'FFF', undefined)).toBe(45); // brand override
    expect(resolveCoverageTarget(s, 'FFF', 2)).toBeCloseTo(45 * 0.7, 10); // override * (1 - 30%)
    expect(resolveCoverageTarget(s, 'FFA', 4)).toBe(0); // -100% → never re-buy
  });

  it('ignores non-positive/garbage brand overrides', () => {
    const s: BuyerSettings = { ...DEFAULT_BUYER_SETTINGS, brand_coverage_overrides: { FFF: 0 } };
    expect(resolveCoverageTarget(s, 'FFF', undefined)).toBe(30);
  });
});

describe('isDead + reorderFlag', () => {
  it('dead = stock sitting with zero blended velocity', () => {
    expect(isDead(25, 0)).toBe(true);
    expect(isDead(0, 0)).toBe(false); // inactive, not dead
    expect(isDead(25, 0.4)).toBe(false);
  });

  it('reorder only for STOCKOUT/High and never for dead stock', () => {
    expect(reorderFlag('STOCKOUT', false)).toBe(true);
    expect(reorderFlag('High', false)).toBe(true);
    expect(reorderFlag('Medium', false)).toBe(false);
    expect(reorderFlag('Low', false)).toBe(false);
    expect(reorderFlag('STOCKOUT', true)).toBe(false);
    expect(reorderFlag('High', true)).toBe(false);
  });
});

describe('trendPct', () => {
  it('is the relative change of 30d vs 30-90d velocity', () => {
    expect(trendPct(2.0, 1.5)).toBeCloseTo((2.0 - 1.5) / 1.5, 10);
    expect(trendPct(1.0, 2.0)).toBeCloseTo(-0.5, 10);
  });

  it('guards div-0: null when the 30-90d base is 0', () => {
    expect(trendPct(2.0, 0)).toBeNull();
  });
});

describe('deriveSkuMetrics (end-to-end assembly)', () => {
  it('derives the healthy baseline SKU coherently', () => {
    // EOQ off here to pin the coverage-fill math in isolation; the EOQ top-up
    // has its own describe block below.
    const d = deriveSkuMetrics(stats(), { ...DEFAULT_BUYER_SETTINGS, eoq_enabled: false }, 0);
    expect(d.weighted_velocity).toBeCloseTo(1.65, 10);
    expect(d.coverage_days).toBeCloseTo(36.36, 1);
    expect(d.coverage_target_days).toBe(30);
    expect(d.coverage_gap_days).toBeCloseTo(30 - 36.36, 1);
    expect(d.stockout_risk).toBe('Low');
    expect(d.is_dead).toBe(false);
    expect(d.reorder).toBe(false);
    expect(d.trend_pct).toBeCloseTo(1 / 3, 5);
    expect(d.suggested_buy_qty).toBe(13);
    expect(d.eoq_base_qty).toBe(13);
  });

  it('flags a stocked-out seller for reorder', () => {
    const d = deriveSkuMetrics(stats({ qty: 0 }), DEFAULT_BUYER_SETTINGS, 0);
    expect(d.stockout_risk).toBe('STOCKOUT');
    expect(d.reorder).toBe(true);
    // 1.65 * 44 = 72.6 → 73 wanted from zero
    expect(d.suggested_buy_qty).toBe(73);
  });

  it('marks dead stock and keeps it out of the queue', () => {
    const d = deriveSkuMetrics(
      stats({
        qty: 25,
        avg_daily_sales_30d: 0,
        avg_daily_sales_30_90d: 0,
        avg_daily_sales_90_180d: 0,
      }),
      DEFAULT_BUYER_SETTINGS,
      0,
    );
    expect(d.is_dead).toBe(true);
    expect(d.stockout_risk).toBe('Low');
    expect(d.reorder).toBe(false);
    expect(d.coverage_days).toBeNull();
    expect(d.coverage_gap_days).toBeNull();
    expect(d.trend_pct).toBeNull();
    expect(d.suggested_buy_qty).toBe(0);
  });

  it('applies brand override + profitability adjust to the target and the buy qty', () => {
    // EOQ off to pin the coverage-fill figure; the top-up is tested separately.
    const s: BuyerSettings = { ...DEFAULT_BUYER_SETTINGS, brand_coverage_overrides: { FFF: 60 }, eoq_enabled: false };
    const d = deriveSkuMetrics(stats({ profitability_level: 3 }), s, 0);
    expect(d.coverage_target_days).toBe(30); // 60 * (1 − 50%)
    // 1.65 * (30 + 14) − 60 = 12.6 → 13
    expect(d.suggested_buy_qty).toBe(13);
  });
});

describe('compareByRisk', () => {
  it('orders STOCKOUT → High → Medium → Low, thin coverage first, nulls last', () => {
    const rows = [
      { sku: 'C', stockout_risk: 'Medium' as const, coverage_days: 20, suggested_buy_qty: 5 },
      { sku: 'A', stockout_risk: 'STOCKOUT' as const, coverage_days: 0, suggested_buy_qty: 40 },
      { sku: 'D', stockout_risk: 'Low' as const, coverage_days: null, suggested_buy_qty: 0 },
      { sku: 'B', stockout_risk: 'High' as const, coverage_days: 6, suggested_buy_qty: 12 },
      { sku: 'B2', stockout_risk: 'High' as const, coverage_days: 3, suggested_buy_qty: 12 },
    ];
    const sorted = [...rows].sort(compareByRisk).map((r) => r.sku);
    expect(sorted).toEqual(['A', 'B2', 'B', 'C', 'D']);
  });
});

// ── structured reason codes ─────────────────────────────────────────

import { skuReasons } from '../src/buyer-metrics';

describe('skuReasons', () => {
  const base = { avg_daily_sales_30d: 1, avg_daily_sales_30_90d: 1, avg_daily_sales_90_180d: 1 };
  const derive = (qty: number, incoming = 0, level?: number, age: number | null = null) =>
    deriveSkuMetrics(
      { ...stats({ sku: 'X', qty, ...base }), age_of_oldest_item_days: age, ...(level ? { profitability_level: level } : {}) },
      DEFAULT_BUYER_SETTINGS,
      incoming,
    );

  it('leads with the risk driver and carries the actual numbers', () => {
    const d = derive(0);
    const reasons = skuReasons(d, { age_of_oldest_item_days: null, qty: 0 }, DEFAULT_BUYER_SETTINGS);
    expect(reasons[0]!.code).toBe('STOCKED_OUT_SELLING');
    expect(reasons[0]!.detail).toContain('1.00/day');
  });

  it('explains a High-risk row via lead-time cover and flags inbound covering the gap', () => {
    // qty 5 at velocity 1 → cover 5d < lead 14d (High); inbound 60 kills the buy.
    const d = derive(5, 60);
    expect(d.stockout_risk).toBe('High');
    expect(d.suggested_buy_qty).toBe(0);
    const codes = skuReasons(d, { age_of_oldest_item_days: null, qty: 5 }, DEFAULT_BUYER_SETTINGS).map((r) => r.code);
    expect(codes).toContain('BELOW_LEAD_TIME_COVER');
    expect(codes).toContain('INBOUND_COVERS_GAP');
  });

  it('reports profitability suppression and aging tiers', () => {
    const d = derive(100, 0, 4, 200);
    const codes = skuReasons(d, { age_of_oldest_item_days: 200, profitability_level: 4, qty: 100 }, DEFAULT_BUYER_SETTINGS).map(
      (r) => r.code,
    );
    expect(codes).toContain('PROFITABILITY_TIER_SUPPRESSED');
    expect(codes).toContain('AGED_180');
    expect(codes).not.toContain('AGED_90');
  });
});

// ── forward (forecast-based) math ───────────────────────────────────

import { forwardCoverageDays, forecastUnitsWindow, resolveLeadTime } from '../src/buyer-metrics';

const F = (arr: number[], frac = 1) => ({ forecast: arr, month0_fraction: frac });

describe('forwardCoverageDays', () => {
  it('walks months and pro-rates the month stock runs out', () => {
    // 25 units vs forecast 10/mo: 2 full months + half of month 3 = 75 days.
    expect(forwardCoverageDays(25, F([10, 10, 10, 10]))).toBe(75);
  });

  it('passes zero-demand months in full and pro-rates month 0', () => {
    // Half of month 0 left at 10 units forecast → 5 effective demand over 15d.
    // Stock 5 exactly covers month 0 (15d), coasts through the dead month 1
    // (30d), and runs out the instant demand resumes → 45 days.
    expect(forwardCoverageDays(5, F([10, 0, 10], 0.5))).toBe(45);
    // With stock to spare into month 2 it pro-rates: 10 units → 5 left after
    // month 0, dead month passes, half of month 2's demand → 15 + 30 + 15 = 60.
    expect(forwardCoverageDays(10, F([10, 0, 10], 0.5))).toBe(60);
  });

  it('returns the horizon cap with stock left and null with no demand', () => {
    expect(forwardCoverageDays(1000, F([1, 1, 1]))).toBe(90); // >= horizon
    expect(forwardCoverageDays(10, F([0, 0, 0]))).toBeNull();
  });
});

describe('forecastUnitsWindow', () => {
  it('sums pro-rated demand over the window', () => {
    // 45-day window over 10/mo: month 0 full (10) + half month 1 (5).
    expect(forecastUnitsWindow(F([10, 10, 10]), 45)).toBe(15);
    // Month 0 half-gone: 15d at 5 eff units + 30d at 10 = window 45 → 5 + 10 = 15.
    expect(forecastUnitsWindow(F([10, 10, 10], 0.5), 45)).toBe(15);
  });
});

describe('deriveSkuMetrics forward basis', () => {
  const seasonal = stats({
    sku: 'BULKY-1',
    qty: 30,
    avg_daily_sales_30d: 0.2,
    avg_daily_sales_30_90d: 0.2,
    avg_daily_sales_90_180d: 0.2,
  });

  it('switches risk + buy to the forecast where one exists', () => {
    // Trailing: velocity 0.2 → cover 150d (Low). Forward: 60/mo ramp → cover
    // 15d (High: < 14d lead? 15 >= 14 → Medium under 30d target).
    const d = deriveSkuMetrics(seasonal, DEFAULT_BUYER_SETTINGS, 0, F([60, 60, 60]));
    expect(d.basis).toBe('forward');
    expect(d.forward_coverage_days).toBe(15);
    expect(d.coverage_days).toBe(150);
    expect(d.stockout_risk).toBe('Medium');
    // Buy sizes from forecast demand over target+lead (44d): 60 + 28 = 88 − 30 on hand = 58.
    expect(d.suggested_buy_qty).toBe(58);
  });

  it('falls back to trailing with no forecast demand or risk_basis trailing', () => {
    const noFc = deriveSkuMetrics(seasonal, DEFAULT_BUYER_SETTINGS, 0, F([0, 0, 0]));
    expect(noFc.basis).toBe('trailing');
    expect(noFc.stockout_risk).toBe('Low');
    const forced = deriveSkuMetrics(
      seasonal,
      { ...DEFAULT_BUYER_SETTINGS, risk_basis: 'trailing' },
      0,
      F([60, 60, 60]),
    );
    expect(forced.basis).toBe('trailing');
    expect(forced.stockout_risk).toBe('Low');
  });

  it('screams STOCKOUT pre-season and keeps forecast-backed stock alive', () => {
    // Zero stock, zero trailing sales, forecast demand this month → STOCKOUT.
    const preSeason = deriveSkuMetrics(
      stats({ sku: 'WIDGET-1', qty: 0 }),
      DEFAULT_BUYER_SETTINGS,
      0,
      F([20, 40, 40]),
    );
    expect(preSeason.stockout_risk).toBe('STOCKOUT');
    // Stock with zero trailing sales but forecast demand is NOT dead.
    const winter = deriveSkuMetrics(
      stats({ sku: 'WIDGET-2', qty: 12 }),
      DEFAULT_BUYER_SETTINGS,
      0,
      F([6, 6, 6]),
    );
    expect(winter.is_dead).toBe(false);
  });

  it('resolves lead time + coverage via brand > class > default', () => {
    const s = {
      ...DEFAULT_BUYER_SETTINGS,
      brand_lead_time_overrides: { FFF: 60 },
      class_lead_time_overrides: { Bulky: 90 },
      class_coverage_overrides: { Bulky: 120 },
    };
    expect(resolveLeadTime(s, 'FFF', 'Bulky')).toBe(60);
    expect(resolveLeadTime(s, 'LLL', 'Bulky')).toBe(90);
    expect(resolveLeadTime(s, 'LLL', 'Accessories')).toBe(14);
    expect(resolveCoverageTarget(s, 'LLL', undefined, 'Bulky')).toBe(120);
    expect(resolveCoverageTarget(s, 'LLL', undefined, 'Accessories')).toBe(30);
  });
});

// ── brand consolidation ─────────────────────────────────────────────

import { consolidateBrandLabels } from '../src/buyer-metrics';

describe('consolidateBrandLabels', () => {
  it('maps prefix-fallback brands onto the real sibling label', () => {
    const out = consolidateBrandLabels([
      { sku: 'BBB:2001', brand: 'Brand B' }, // tracked -> real label
      { sku: 'BBB:9999', brand: 'BBB' }, // untracked -> prefix, adopts Brand B
      { sku: 'FFF:1002', brand: 'Brand F' },
      { sku: 'FFF:2000', brand: 'FFF' },
      { sku: 'XYZ:1', brand: 'XYZ' }, // no real sibling -> unchanged
    ]);
    expect(out.map((r) => r.brand)).toEqual(['Brand B', 'Brand B', 'Brand F', 'Brand F', 'XYZ']);
  });

  it('picks the most common label when siblings disagree', () => {
    const out = consolidateBrandLabels([
      { sku: 'OOC:1', brand: 'Brand P and Q' },
      { sku: 'OOC:2', brand: 'Brand P and Q' },
      { sku: 'OOC:3', brand: 'Brand P & Q' },
      { sku: 'OOC:4', brand: 'OOC' },
    ]);
    expect(out.find((r) => r.sku === 'OOC:4')!.brand).toBe('Brand P and Q');
  });

  it('is a no-op when no real labels exist (all prefixes)', () => {
    const rows = [{ sku: 'FFF:1', brand: 'FFF' }, { sku: 'LLL:1', brand: 'LLL' }];
    expect(consolidateBrandLabels(rows)).toEqual(rows);
  });

  it('collapses labels that differ only in case onto the most common spelling', () => {
    const out = consolidateBrandLabels([
      { sku: 'BBB:1', brand: 'Brand B' },
      { sku: 'BBB:2', brand: 'Brand B' },
      { sku: 'BBB:3', brand: 'BRAND B' }, // case variant -> majority spelling
      { sku: 'BBB:4', brand: 'BBB' }, // prefix row -> label, then the same group
      { sku: 'OOA:1', brand: 'Brand P and Q' },
      { sku: 'OOA:2', brand: 'brand p and q' }, // 1-1 tie -> alphabetical
    ]);
    expect(out.map((r) => r.brand)).toEqual([
      'Brand B',
      'Brand B',
      'Brand B',
      'Brand B',
      'Brand P and Q',
      'Brand P and Q',
    ]);
  });
});

describe('brand overrides match the feed label case-insensitively', () => {
  const s: BuyerSettings = {
    ...DEFAULT_BUYER_SETTINGS,
    brand_coverage_overrides: { 'BRAND B': 200, FFF: 90 },
    brand_lead_time_overrides: { BBB: 45 },
  };
  it('a stored upper-cased key applies to the mixed-case label', () => {
    expect(resolveCoverageTarget(s, 'Brand B', undefined)).toBe(200);
    expect(resolveCoverageTarget(s, 'FFF', undefined)).toBe(90); // all-caps unchanged
  });
  it('a 3-char code key applies through the SKU prefix, the label beating the code', () => {
    expect(resolveLeadTime(s, 'Brand B', undefined, 'BBB:2001')).toBe(45);
    expect(resolveLeadTime(s, 'Brand B', undefined)).toBe(14); // no SKU, no code match
    const both: BuyerSettings = { ...s, brand_coverage_overrides: { BBB: 120, 'BRAND B': 200 } };
    expect(resolveCoverageTarget(both, 'Brand B', undefined, undefined, 'BBB:2001')).toBe(200);
  });
});

describe('deriveSkuMetrics queue-quality guards', () => {
  it('#1 suppresses a forecast-only buy when the SKU has never sold', () => {
    const neverSold = stats({
      sku: 'GHOST-1',
      qty: 0,
      avg_daily_sales_30d: 0,
      avg_daily_sales_30_90d: 0,
      avg_daily_sales_90_180d: 0,
      avg_daily_sales_180_270d: 0,
      avg_daily_sales_270_360d: 0,
      avg_daily_sales_all_time: 0,
    });
    const d = deriveSkuMetrics(neverSold, DEFAULT_BUYER_SETTINGS, 0, F([5, 5, 5]));
    expect(d.basis).toBe('trailing'); // forecast not trusted without history
    expect(d.stockout_risk).toBe('Low'); // not a phantom STOCKOUT
    expect(d.reorder).toBe(false);
    expect(d.suggested_buy_qty).toBe(0);
    expect(d.forecast_only).toBe(true);
  });

  it('#1 still trusts the forecast for a SKU that has sold before (seasonal)', () => {
    const soldBefore = stats({
      sku: 'WIDGET-9',
      qty: 0,
      avg_daily_sales_30d: 0,
      avg_daily_sales_30_90d: 0,
      avg_daily_sales_90_180d: 0,
      avg_daily_sales_all_time: 0.3, // sold last season
    });
    const d = deriveSkuMetrics(soldBefore, DEFAULT_BUYER_SETTINGS, 0, F([20, 40, 40]));
    expect(d.stockout_risk).toBe('STOCKOUT'); // pre-season ramp still fires
    expect(d.forecast_only).toBe(false);
  });

  it('#2 keeps seasonal-class SKUs out of the reorder queue', () => {
    const seasonalSku = stats({ sku: 'BRA:SEAS', qty: 0, class_1: 'CLASS_P' });
    const d = deriveSkuMetrics(seasonalSku, DEFAULT_BUYER_SETTINGS, 0, F([5, 5, 5]));
    expect(d.stockout_risk).toBe('STOCKOUT'); // still flagged risky
    expect(d.seasonal_class).toBe(true);
    expect(d.reorder).toBe(false); // but NOT on the queue
    // same profile in a non-seasonal class DOES reorder
    const acc = deriveSkuMetrics(stats({ sku: 'ACC:1', qty: 0 }), DEFAULT_BUYER_SETTINGS, 0, F([5, 5, 5]));
    expect(acc.seasonal_class).toBe(false);
    expect(acc.reorder).toBe(true);
  });
});

// ── EOQ line quantities ──────────────────────────────────────────

describe('annualDemandUnits', () => {
  it('sums the forward forecast (month 0 pro-rated) when a forecast exists', () => {
    // 12 months of 10 each, month0 half elapsed -> 10*0.5 + 10*11 = 115.
    expect(annualDemandUnits(0, F(Array(12).fill(10), 0.5))).toBeCloseTo(115, 6);
  });

  it('falls back to velocity x 365 when no forecast demand', () => {
    expect(annualDemandUnits(2, null)).toBe(730);
    // A forecast that carries no demand also falls back to velocity.
    expect(annualDemandUnits(2, F([0, 0, 0]))).toBe(730);
  });

  it('is 0 when neither forecast nor velocity carries demand', () => {
    expect(annualDemandUnits(0, null)).toBe(0);
    expect(annualDemandUnits(0, F([0, 0]))).toBe(0);
  });
});

describe('economicOrderQty', () => {
  it('computes sqrt(2 D K / h) with h = holding_rate x unit_cost', () => {
    // D=1000, K=4, h=0.25*20=5 -> sqrt(2*1000*4/5) = sqrt(1600) = 40.
    expect(
      economicOrderQty({ annual_demand: 1000, handling_cost_per_line: 4, holding_rate_annual: 0.25, unit_cost: 20 }),
    ).toBeCloseTo(40, 6);
  });

  it('uses the documented fallback unit cost when cost is missing', () => {
    const withFallback = economicOrderQty({
      annual_demand: 1000,
      handling_cost_per_line: 4,
      holding_rate_annual: 0.25,
      unit_cost: null,
    });
    const explicit = economicOrderQty({
      annual_demand: 1000,
      handling_cost_per_line: 4,
      holding_rate_annual: 0.25,
      unit_cost: EOQ_FALLBACK_UNIT_COST,
    });
    expect(withFallback).toBeCloseTo(explicit, 10);
  });

  it('shrinks as the item gets more expensive (higher h -> smaller batch)', () => {
    const cheap = economicOrderQty({ annual_demand: 1000, handling_cost_per_line: 4, holding_rate_annual: 0.25, unit_cost: 5 });
    const dear = economicOrderQty({ annual_demand: 1000, handling_cost_per_line: 4, holding_rate_annual: 0.25, unit_cost: 700 });
    expect(dear).toBeLessThan(cheap);
  });

  it('is 0 for degenerate inputs (no demand / no K / no h)', () => {
    expect(economicOrderQty({ annual_demand: 0, handling_cost_per_line: 4, holding_rate_annual: 0.25, unit_cost: 20 })).toBe(0);
    expect(economicOrderQty({ annual_demand: 1000, handling_cost_per_line: 0, holding_rate_annual: 0.25, unit_cost: 20 })).toBe(0);
    expect(economicOrderQty({ annual_demand: 1000, handling_cost_per_line: 4, holding_rate_annual: 0, unit_cost: 20 })).toBe(0);
  });
});

describe('applyEoqLineQty', () => {
  const set = {
    eoq_enabled: true,
    handling_cost_per_line: 4,
    holding_rate_annual: 0.25,
    eoq_max_cover_days: 180,
  };

  it('rounds a cheap slow-moving line UP to the economic batch', () => {
    // Steady slow seller: D=60/yr, cost $8 -> h=2, EOQ=sqrt(2*60*4/2)=sqrt(240)=15.49->15.
    // base 1 (one every few weeks). Cover cap at 180d = 60/365*180 = 29 units, so 15 binds.
    const r = applyEoqLineQty({
      baseQty: 1,
      velocity: 60 / 365,
      forward: null,
      unit_cost: 8,
      is_dead: false,
      settings: set,
    });
    expect(r.applied).toBe(true);
    expect(r.qty).toBe(15);
  });

  it('leaves an expensive low-demand item at its base (EOQ below base)', () => {
    // $700 item, D=6/yr -> h=175, EOQ=sqrt(2*6*4/175)=sqrt(0.274)=0.52 -> round 1.
    // base 1: max(1, min(1, cap)) = 1, no raise.
    const r = applyEoqLineQty({
      baseQty: 1,
      velocity: 6 / 365,
      forward: null,
      unit_cost: 700,
      is_dead: false,
      settings: set,
    });
    expect(r.applied).toBe(false);
    expect(r.qty).toBe(1);
  });

  it('binds the raise at the cover cap (never past eoq_max_cover_days)', () => {
    // Very cheap, high K: EOQ huge, but a 30-day cover cap limits it.
    // D=365/yr (1/day), cost $1 -> h=0.25, EOQ=sqrt(2*365*20/0.25)=sqrt(58400)=241.
    // cap at 30d = 365/365*30 = 30. base 5 -> min(241,30)=30.
    const r = applyEoqLineQty({
      baseQty: 5,
      velocity: 1,
      forward: null,
      unit_cost: 1,
      is_dead: false,
      settings: { ...set, handling_cost_per_line: 20, eoq_max_cover_days: 30 },
    });
    expect(r.applied).toBe(true);
    expect(r.qty).toBe(30);
  });

  it('does not raise when the base already meets the cover cap', () => {
    // base 40 already exceeds a 30-unit cover cap -> untouched.
    const r = applyEoqLineQty({
      baseQty: 40,
      velocity: 1,
      forward: null,
      unit_cost: 1,
      is_dead: false,
      settings: { ...set, eoq_max_cover_days: 30 },
    });
    expect(r.applied).toBe(false);
    expect(r.qty).toBe(40);
  });

  it('never escalates dead stock', () => {
    const r = applyEoqLineQty({ baseQty: 1, velocity: 60 / 365, forward: null, unit_cost: 8, is_dead: true, settings: set });
    expect(r.applied).toBe(false);
    expect(r.qty).toBe(1);
  });

  it('never escalates a SKU carrying a dead label, default or caller-supplied', () => {
    for (const [label, dead_labels] of [['Dead', undefined], ['Rundown-X', ['Dead', 'Rundown-X']]] as const) {
      const r = applyEoqLineQty({
        baseQty: 1,
        velocity: 60 / 365,
        forward: null,
        unit_cost: 8,
        is_dead: false,
        settings: set,
        ctx: { label, dead_labels },
      });
      expect(r.applied).toBe(false);
      expect(r.qty).toBe(1);
    }
  });

  it('never escalates an excluded (clearance/discontinued) SKU', () => {
    const r = applyEoqLineQty({
      baseQty: 1,
      velocity: 60 / 365,
      forward: null,
      unit_cost: 8,
      is_dead: false,
      settings: set,
      ctx: { excluded: true },
    });
    expect(r.applied).toBe(false);
  });

  it('is a passthrough when EOQ is disabled', () => {
    const r = applyEoqLineQty({
      baseQty: 1,
      velocity: 60 / 365,
      forward: null,
      unit_cost: 8,
      is_dead: false,
      settings: { ...set, eoq_enabled: false },
    });
    expect(r.applied).toBe(false);
    expect(r.qty).toBe(1);
  });

  it('never conjures a buy from a zero base', () => {
    const r = applyEoqLineQty({ baseQty: 0, velocity: 60 / 365, forward: null, unit_cost: 8, is_dead: false, settings: set });
    expect(r.applied).toBe(false);
    expect(r.qty).toBe(0);
  });

  it('does not escalate a SKU with zero forward demand', () => {
    const r = applyEoqLineQty({ baseQty: 1, velocity: 0, forward: F([0, 0, 0]), unit_cost: 8, is_dead: false, settings: set });
    expect(r.applied).toBe(false);
    expect(r.qty).toBe(1);
  });
});

describe('deriveSkuMetrics EOQ top-up', () => {
  it('raises a cheap slow line and stamps eoq fields + EOQ_TOPUP reason', () => {
    // A cheap accessory that the coverage math wants ~1 of.
    const s = stats({
      unit_cost: 8,
      qty: 2,
      avg_daily_sales_30d: 0.16,
      avg_daily_sales_30_90d: 0.16,
      avg_daily_sales_90_180d: 0.16,
    });
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0);
    expect(d.eoq_applied).toBe(true);
    expect(d.eoq_qty).toBeGreaterThan(d.eoq_base_qty);
    expect(d.suggested_buy_qty).toBe(d.eoq_qty);
    const r = skuReasonsFor(d, s);
    expect(r.some((x) => x.code === 'EOQ_TOPUP')).toBe(true);
  });

  it('keeps an expensive low-demand item at its coverage-fill base', () => {
    // $700 item, thin steady demand -> base ~ a couple units, EOQ below it.
    const s = stats({
      brand: 'BRD',
      class_1: 'Accessories',
      unit_cost: 700,
      qty: 0,
      avg_daily_sales_30d: 0.02,
      avg_daily_sales_30_90d: 0.02,
      avg_daily_sales_90_180d: 0.02,
      avg_daily_sales_all_time: 0.02,
    });
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0);
    expect(d.eoq_applied).toBe(false);
    expect(d.suggested_buy_qty).toBe(d.eoq_base_qty);
  });

  it('is a passthrough when eoq_enabled is false', () => {
    const s = stats({
      unit_cost: 8,
      qty: 2,
      avg_daily_sales_30d: 0.16,
      avg_daily_sales_30_90d: 0.16,
      avg_daily_sales_90_180d: 0.16,
    });
    const on = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0);
    const off = deriveSkuMetrics(s, { ...DEFAULT_BUYER_SETTINGS, eoq_enabled: false }, 0);
    expect(off.eoq_applied).toBe(false);
    expect(off.suggested_buy_qty).toBe(off.eoq_base_qty);
    expect(on.suggested_buy_qty).toBeGreaterThan(off.suggested_buy_qty);
  });

  it('does not escalate a Dead-labelled SKU via eoqCtx', () => {
    const s = stats({
      unit_cost: 8,
      qty: 2,
      avg_daily_sales_30d: 0.16,
      avg_daily_sales_30_90d: 0.16,
      avg_daily_sales_90_180d: 0.16,
    });
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0, null, { label: 'Dead' });
    expect(d.eoq_applied).toBe(false);
  });
});

/** skuReasons wrapper with the minimal stats a reason needs. */
function skuReasonsFor(d: ReturnType<typeof deriveSkuMetrics>, s: ReturnType<typeof stats>) {
  return skuReasons(d, s, DEFAULT_BUYER_SETTINGS);
}

// ── Three-state saleability ──────────────────────────────────────

import { resolveSaleability, resolveDemandBasis } from '../src/buyer-metrics';

describe('resolveSaleability', () => {
  it('own stock present is always IN_STOCK regardless of marketplace evidence', () => {
    expect(resolveSaleability({ own_qty: 5, marketplace_soh: 0, is_saleable: 0 }).state).toBe('IN_STOCK');
    expect(resolveSaleability({ own_qty: 5 }).state).toBe('IN_STOCK');
  });

  it('own 0 + live marketplace stock > 0 is MARKETPLACE_ONLY', () => {
    const r = resolveSaleability({ own_qty: 0, marketplace_soh: 12 });
    expect(r.state).toBe('MARKETPLACE_ONLY');
    expect(r.marketplace_soh).toBe(12);
    expect(r.no_marketplace_evidence).toBe(false);
  });

  it('own 0 + is_saleable=1 is MARKETPLACE_ONLY even with no soh number', () => {
    expect(resolveSaleability({ own_qty: 0, is_saleable: 1 }).state).toBe('MARKETPLACE_ONLY');
  });

  it('own 0 + explicit is_saleable=0 + no marketplace soh is TRULY_OUT', () => {
    const r = resolveSaleability({ own_qty: 0, is_saleable: 0, marketplace_soh: 0 });
    expect(r.state).toBe('TRULY_OUT');
    expect(r.no_marketplace_evidence).toBe(false);
  });

  it('falls back to the monthly marketplace_soh when the live figure is null', () => {
    const r = resolveSaleability({ own_qty: 0, marketplace_soh: null, fallback_marketplace_soh: 30 });
    expect(r.state).toBe('MARKETPLACE_ONLY');
    expect(r.marketplace_soh).toBe(30);
  });

  it('live marketplace_soh wins over the monthly fallback', () => {
    const r = resolveSaleability({ own_qty: 0, marketplace_soh: 0, fallback_marketplace_soh: 99 });
    // Live 0 present (not null) => marketplace not selling; fallback is not consulted.
    expect(r.state).toBe('TRULY_OUT');
    expect(r.marketplace_soh).toBe(0);
  });

  it('live is_saleable=0 is authoritative: a stale positive fallback never outvotes it', () => {
    // The bug this guards: live flag says unsaleable, live soh is NULL, but the
    // monthly cache (up to ~4 weeks old) still carries positive marketplace
    // stock. The SKU must resolve TRULY_OUT (real stockout urgency, counted in
    // revenue-loss, censoring fix applies) - not MARKETPLACE_ONLY.
    const r = resolveSaleability({
      own_qty: 0,
      marketplace_soh: null,
      is_saleable: 0,
      fallback_marketplace_soh: 40,
    });
    expect(r.state).toBe('TRULY_OUT');
    expect(r.no_marketplace_evidence).toBe(false);
    // The rejected stale fallback is not reported as the SOH in force.
    expect(r.marketplace_soh).toBe(null);
  });

  it('DEGRADES to exact own-stock-only semantics when NO evidence exists', () => {
    const out = resolveSaleability({ own_qty: 0 });
    expect(out.state).toBe('TRULY_OUT');
    expect(out.no_marketplace_evidence).toBe(true);
    expect(out.marketplace_soh).toBe(null);
    const inStock = resolveSaleability({ own_qty: 3 });
    expect(inStock.state).toBe('IN_STOCK');
    expect(inStock.no_marketplace_evidence).toBe(true);
  });
});

describe('resolveDemandBasis (censoring max())', () => {
  it('returns the forward figure untouched when the correction is off', () => {
    expect(resolveDemandBasis({ forwardFigure: 10, trailingFigure: 40, applyCorrection: false })).toEqual({
      figure: 10,
      uncensored: false,
    });
  });
  it('takes max and flags uncensored when trailing strictly wins', () => {
    expect(resolveDemandBasis({ forwardFigure: 10, trailingFigure: 40, applyCorrection: true })).toEqual({
      figure: 40,
      uncensored: true,
    });
  });
  it('keeps forward (no flag) when forward already >= trailing', () => {
    expect(resolveDemandBasis({ forwardFigure: 50, trailingFigure: 40, applyCorrection: true })).toEqual({
      figure: 50,
      uncensored: false,
    });
  });
});

describe('deriveSkuMetrics saleability wiring', () => {
  const selling = { avg_daily_sales_30d: 1.5, avg_daily_sales_30_90d: 1.2, avg_daily_sales_90_180d: 1.0 };

  it('own 0 + marketplace stock: MARKETPLACE_ONLY, NOT a STOCKOUT', () => {
    const d = deriveSkuMetrics(stats({ qty: 0, marketplace_soh: 20, ...selling }), DEFAULT_BUYER_SETTINGS, 0);
    expect(d.saleability).toBe('MARKETPLACE_ONLY');
    expect(d.mp_only_selling).toBe(true);
    expect(d.stockout_risk).not.toBe('STOCKOUT');
  });

  it('own 0 + no marketplace stock (is_saleable 0): TRULY_OUT and STOCKOUT', () => {
    const d = deriveSkuMetrics(stats({ qty: 0, marketplace_soh: 0, is_saleable: 0, ...selling }), DEFAULT_BUYER_SETTINGS, 0);
    expect(d.saleability).toBe('TRULY_OUT');
    expect(d.mp_only_selling).toBe(false);
    expect(d.stockout_risk).toBe('STOCKOUT');
  });

  it('own 0 + NO marketplace evidence degrades to own-stock STOCKOUT semantics', () => {
    // No marketplace_soh, no is_saleable, no fallback => own-stock-only.
    const d = deriveSkuMetrics(stats({ qty: 0, ...selling }), DEFAULT_BUYER_SETTINGS, 0);
    expect(d.saleability).toBe('TRULY_OUT');
    expect(d.stockout_risk).toBe('STOCKOUT');
  });

  it('MARKETPLACE_ONLY keeps a coverage-based reorder suggestion (own 0 => High risk)', () => {
    const d = deriveSkuMetrics(stats({ qty: 0, marketplace_soh: 20, ...selling }), DEFAULT_BUYER_SETTINGS, 0);
    expect(d.reorder).toBe(true);
    expect(d.suggested_buy_qty).toBeGreaterThan(0);
  });

  it('a MARKETPLACE_ONLY seller carries the MP_FULFILLED reason, not STOCKED_OUT_SELLING', () => {
    const d = deriveSkuMetrics(stats({ qty: 0, marketplace_soh: 20, ...selling }), DEFAULT_BUYER_SETTINGS, 0);
    const codes = skuReasons(d, { age_of_oldest_item_days: null, qty: 0 }, DEFAULT_BUYER_SETTINGS).map((r) => r.code);
    expect(codes).toContain('MP_FULFILLED');
    expect(codes).not.toContain('STOCKED_OUT_SELLING');
  });
});

describe('deriveSkuMetrics censoring quick fix', () => {
  // A TRULY_OUT seller whose forecast is censored (near-zero forward demand)
  // but whose trailing sales are strong: the buy must use the trailing figure.
  const trulyOutSelling = stats({
    qty: 0,
    is_saleable: 0,
    marketplace_soh: 0,
    unit_cost: 30,
    avg_daily_sales_30d: 2.0,
    avg_daily_sales_30_90d: 2.0,
    avg_daily_sales_90_180d: 2.0,
  });
  // Censored forecast: forward demand is a trickle vs the trailing 2/day.
  const censored = F([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);

  it('uses max(forward, trailing) for a TRULY_OUT seller and flags DEMAND_UNCENSORED', () => {
    const d = deriveSkuMetrics(trulyOutSelling, DEFAULT_BUYER_SETTINGS, 0, censored);
    expect(d.saleability).toBe('TRULY_OUT');
    // Trailing want over (30+14)d = 2 * 44 = 88; censored forward want ~ 1.4.
    // The buy should reflect the far larger trailing figure.
    expect(d.suggested_buy_qty).toBeGreaterThan(50);
    expect(d.demand_uncensored).toBe(true);
    const codes = skuReasons(d, { age_of_oldest_item_days: null, qty: 0 }, DEFAULT_BUYER_SETTINGS).map((r) => r.code);
    expect(codes).toContain('DEMAND_UNCENSORED');
  });

  it('does NOT apply the correction to a MARKETPLACE_ONLY seller (uncensored sales)', () => {
    const d = deriveSkuMetrics({ ...trulyOutSelling, marketplace_soh: 25, is_saleable: 1 }, DEFAULT_BUYER_SETTINGS, 0, censored);
    expect(d.saleability).toBe('MARKETPLACE_ONLY');
    expect(d.demand_uncensored).toBe(false);
  });

  it('does NOT apply the correction to an in-stock SKU', () => {
    const d = deriveSkuMetrics({ ...trulyOutSelling, qty: 50 }, DEFAULT_BUYER_SETTINGS, 0, censored);
    expect(d.saleability).toBe('IN_STOCK');
    expect(d.demand_uncensored).toBe(false);
  });

  it('does not flag DEMAND_UNCENSORED when the forecast already exceeds trailing', () => {
    // Rich forward forecast (well above trailing 2/day): forward wins, no flag.
    const rich = F([120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120]);
    const d = deriveSkuMetrics(trulyOutSelling, DEFAULT_BUYER_SETTINGS, 0, rich);
    expect(d.demand_uncensored).toBe(false);
  });
});

// ── Pack / minimum order quantities ──────────────────────────────

import { resolveEffectivePack, applyPackRounding, resolveEffectiveMin, applyOrderConstraints } from '../src/buyer-metrics';

describe('resolveEffectivePack', () => {
  it('the buyer override always beats the feed reorder qty', () => {
    expect(resolveEffectivePack(100, 10)).toEqual({ pack: 100, source: 'override' });
  });
  it('falls back to the feed reorder qty when no override is set', () => {
    expect(resolveEffectivePack(null, 10)).toEqual({ pack: 10, source: 'feed' });
    expect(resolveEffectivePack(undefined, 10)).toEqual({ pack: 10, source: 'feed' });
  });
  it('override 0 means unset - the feed value applies', () => {
    expect(resolveEffectivePack(0, 10)).toEqual({ pack: 10, source: 'feed' });
  });
  it('no source set means no pack rule', () => {
    expect(resolveEffectivePack(null, null)).toEqual({ pack: null, source: null });
    expect(resolveEffectivePack(0, 0)).toEqual({ pack: null, source: null });
    expect(resolveEffectivePack(undefined, undefined)).toEqual({ pack: null, source: null });
  });
  it('a fractional feed value rounds to whole units', () => {
    expect(resolveEffectivePack(null, 24.6)).toEqual({ pack: 25, source: 'feed' });
  });
});

describe('applyPackRounding', () => {
  it('floor case: 71 rounds up to one whole pack of 100', () => {
    expect(applyPackRounding({ baseQty: 71, pack: 100, coverCapQty: 500 })).toEqual({
      qty: 100,
      applied: true,
      over_cap: false,
    });
  });
  it('multiple case: 130 rounds up to two packs of 100', () => {
    expect(applyPackRounding({ baseQty: 130, pack: 100, coverCapQty: 500 })).toEqual({
      qty: 200,
      applied: true,
      over_cap: false,
    });
  });
  it('a zero suggestion stays zero - the pack never forces a buy', () => {
    expect(applyPackRounding({ baseQty: 0, pack: 100, coverCapQty: 500 })).toEqual({
      qty: 0,
      applied: false,
      over_cap: false,
    });
  });
  it('an exact multiple passes through unchanged', () => {
    expect(applyPackRounding({ baseQty: 200, pack: 100, coverCapQty: 500 })).toEqual({
      qty: 200,
      applied: false,
      over_cap: false,
    });
  });
  it('no pack rule is a passthrough', () => {
    expect(applyPackRounding({ baseQty: 71, pack: null, coverCapQty: 500 })).toEqual({
      qty: 71,
      applied: false,
      over_cap: false,
    });
  });
  it('flags over_cap when the pack push lands past the cover cap (supplier still wins)', () => {
    const r = applyPackRounding({ baseQty: 10, pack: 100, coverCapQty: 40 });
    expect(r.qty).toBe(100); // supplier reality wins - a whole box it is
    expect(r.applied).toBe(true);
    expect(r.over_cap).toBe(true);
  });
});

describe('deriveSkuMetrics pack rounding', () => {
  // Baseline stats(): velocity 1.65/day, base 13, EOQ raises to 16 (pre-pack).
  const packArgs = [null, undefined, undefined] as const; // forward, eoqCtx, fallbackMpSoh

  it('applies EOQ first, THEN rounds the raised figure up to whole packs', () => {
    const s = stats();
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0, ...packArgs, 25);
    // EOQ raised the coverage-fill base first...
    expect(d.eoq_applied).toBe(true);
    expect(d.eoq_qty).toBeGreaterThan(d.eoq_base_qty);
    // ...then the pack rounded the POST-EOQ figure, not the base.
    expect(d.pre_pack_qty).toBe(d.eoq_qty);
    expect(d.suggested_buy_qty).toBe(Math.ceil(d.eoq_qty / 25) * 25);
    expect(d.pack_applied).toBe(true);
    expect(d.pack_qty).toBe(25);
    expect(d.pack_source).toBe('override');
    const r = skuReasonsFor(d, s);
    expect(r.some((x) => x.code === 'EOQ_TOPUP')).toBe(true);
    const packed = r.find((x) => x.code === 'PACK_ROUNDED');
    expect(packed?.detail).toContain(`${d.pre_pack_qty} -> ${d.suggested_buy_qty}`);
    expect(packed?.detail).toContain('pack of 25');
  });

  it('uses the feed reorder_qty when no buyer override exists', () => {
    const d = deriveSkuMetrics(stats({ reorder_qty: 25 }), DEFAULT_BUYER_SETTINGS, 0);
    expect(d.pack_qty).toBe(25);
    expect(d.pack_source).toBe('feed');
    expect(d.suggested_buy_qty % 25).toBe(0);
  });

  it('the buyer override beats the feed reorder_qty', () => {
    const d = deriveSkuMetrics(stats({ reorder_qty: 10 }), DEFAULT_BUYER_SETTINGS, 0, ...packArgs, 25);
    expect(d.pack_qty).toBe(25);
    expect(d.pack_source).toBe('override');
  });

  it('a zero suggestion stays zero even with a pack in force', () => {
    // Deeply overstocked: coverage-fill base is 0; the pack must not conjure a buy.
    const s = stats({ qty: 500, reorder_qty: 100 });
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0);
    expect(d.suggested_buy_qty).toBe(0);
    expect(d.pack_applied).toBe(false);
    expect(d.pack_qty).toBe(100); // still surfaced for the UI ("orders in packs of 100")
    expect(skuReasonsFor(d, s).some((x) => x.code === 'PACK_ROUNDED')).toBe(false);
  });

  it('no pack sources set is a passthrough (numbers unchanged)', () => {
    const base = deriveSkuMetrics(stats(), DEFAULT_BUYER_SETTINGS, 0);
    expect(base.pack_qty).toBe(null);
    expect(base.pack_applied).toBe(false);
    expect(base.suggested_buy_qty).toBe(base.eoq_qty);
    expect(base.pre_pack_qty).toBe(base.eoq_qty);
  });

  it('flags PACK_OVER_CAP when a whole box exceeds the EOQ cover cap', () => {
    // Slow seller (D=60/yr): the 180d cover cap is 29 units, a box of 100 blows
    // past it. Supplier reality wins - the buy stays 100 - but it is flagged.
    const s = stats({
      unit_cost: 8,
      qty: 0,
      avg_daily_sales_30d: 60 / 365,
      avg_daily_sales_30_90d: 60 / 365,
      avg_daily_sales_90_180d: 60 / 365,
      reorder_qty: 100,
    });
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0);
    expect(d.suggested_buy_qty).toBe(100);
    expect(d.pack_applied).toBe(true);
    expect(d.pack_over_cap).toBe(true);
    const codes = skuReasonsFor(d, s).map((x) => x.code);
    expect(codes).toContain('PACK_ROUNDED');
    expect(codes).toContain('PACK_OVER_CAP');
  });
});

// ── Minimum order quantity split ─────────────────────────────────

describe('resolveEffectiveMin', () => {
  it('a positive override is the floor, rounded to whole units', () => {
    expect(resolveEffectiveMin(10)).toBe(10);
    expect(resolveEffectiveMin(9.6)).toBe(10);
  });
  it('null / 0 / negative / NaN is no floor', () => {
    expect(resolveEffectiveMin(null)).toBe(null);
    expect(resolveEffectiveMin(undefined)).toBe(null);
    expect(resolveEffectiveMin(0)).toBe(null);
    expect(resolveEffectiveMin(-5)).toBe(null);
    expect(resolveEffectiveMin(Number.NaN)).toBe(null);
  });
});

describe('applyOrderConstraints (min floor + pack multiple compose)', () => {
  it('min-only lift: 7 with min 10 (no pack) -> 10', () => {
    expect(applyOrderConstraints({ baseQty: 7, minQty: 10, pack: null, coverCapQty: null })).toEqual({
      qty: 10,
      pre_pack_qty: 10,
      min_applied: true,
      pack_applied: false,
      over_cap: false,
    });
  });
  it('pack-only round: 12 with pack 5 (no min) -> 15', () => {
    expect(applyOrderConstraints({ baseQty: 12, minQty: null, pack: 5, coverCapQty: null })).toEqual({
      qty: 15,
      pre_pack_qty: 12,
      min_applied: false,
      pack_applied: true,
      over_cap: false,
    });
  });
  it('both compose - suggestion 7, min 10, pack 5 -> 10 (min lifts to 10, already a whole pack)', () => {
    expect(applyOrderConstraints({ baseQty: 7, minQty: 10, pack: 5, coverCapQty: null })).toEqual({
      qty: 10,
      pre_pack_qty: 10,
      min_applied: true,
      pack_applied: false, // 10 is already a whole pack of 5 - no rounding
      over_cap: false,
    });
  });
  it('both compose - suggestion 12, min 10, pack 5 -> 15 (min does not bind, pack rounds)', () => {
    expect(applyOrderConstraints({ baseQty: 12, minQty: 10, pack: 5, coverCapQty: null })).toEqual({
      qty: 15,
      pre_pack_qty: 12, // min 10 doesn't bind a base of 12
      min_applied: false,
      pack_applied: true,
      over_cap: false,
    });
  });
  it('a zero base stays zero - neither a min nor a pack conjures a buy', () => {
    expect(applyOrderConstraints({ baseQty: 0, minQty: 100, pack: 50, coverCapQty: null })).toEqual({
      qty: 0,
      pre_pack_qty: 0,
      min_applied: false,
      pack_applied: false,
      over_cap: false,
    });
  });
  it('over_cap fires when the min floor alone lands past the cover cap', () => {
    const r = applyOrderConstraints({ baseQty: 10, minQty: 100, pack: null, coverCapQty: 40 });
    expect(r.qty).toBe(100); // supplier minimum wins
    expect(r.min_applied).toBe(true);
    expect(r.over_cap).toBe(true);
  });
});

describe('deriveSkuMetrics min order quantity', () => {
  const packArgs = [null, undefined, undefined] as const; // forward, eoqCtx, fallbackMpSoh

  it('back-compat: a pack-only override (no min) gives the same figures as with no minimum support', () => {
    const s = stats();
    const withMinUndefined = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0, ...packArgs, 25);
    const withMinNull = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0, ...packArgs, 25, null);
    // The min defaults to "no floor", so the whole derived view is unchanged.
    expect(withMinNull).toEqual(withMinUndefined);
    expect(withMinNull.min_order_qty).toBe(null);
    expect(withMinNull.min_applied).toBe(false);
  });

  it('a min above the EOQ figure lifts the buy and fires MIN_ORDER_APPLIED', () => {
    // Baseline EOQ figure is 16; a min of 40 lifts it (no pack).
    const s = stats();
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0, ...packArgs, null, 40);
    expect(d.eoq_qty).toBeLessThan(40);
    expect(d.min_order_qty).toBe(40);
    expect(d.min_applied).toBe(true);
    expect(d.pre_pack_qty).toBe(40);
    expect(d.suggested_buy_qty).toBe(40); // no pack, so final == floored
    const r = skuReasonsFor(d, s);
    const min = r.find((x) => x.code === 'MIN_ORDER_APPLIED');
    expect(min?.detail).toContain(`${d.eoq_qty} -> 40`);
    expect(min?.detail).toContain('min order 40');
  });

  it('min + pack compose: min lifts, then the pack rounds the floored figure', () => {
    // EOQ 16 -> min 30 -> pack of 7 rounds 30 up to 35.
    const s = stats();
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0, ...packArgs, 7, 30);
    expect(d.min_order_qty).toBe(30);
    expect(d.min_applied).toBe(true);
    expect(d.pre_pack_qty).toBe(30);
    expect(d.pack_qty).toBe(7);
    expect(d.pack_applied).toBe(true);
    expect(d.suggested_buy_qty).toBe(35); // ceil(30/7)*7
    const codes = skuReasonsFor(d, s).map((x) => x.code);
    expect(codes).toContain('MIN_ORDER_APPLIED');
    expect(codes).toContain('PACK_ROUNDED');
  });

  it('a zero suggestion stays zero even with a min in force', () => {
    const s = stats({ qty: 500 }); // deeply overstocked, base 0
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0, ...packArgs, null, 100);
    expect(d.suggested_buy_qty).toBe(0);
    expect(d.min_applied).toBe(false);
    expect(d.min_order_qty).toBe(100); // still surfaced for the UI
    expect(skuReasonsFor(d, s).some((x) => x.code === 'MIN_ORDER_APPLIED')).toBe(false);
  });

  it('the min does not fire when the EOQ figure already meets it', () => {
    // A min of 5 is below the baseline EOQ figure (16), so it never binds.
    const s = stats();
    const d = deriveSkuMetrics(s, DEFAULT_BUYER_SETTINGS, 0, ...packArgs, null, 5);
    expect(d.min_order_qty).toBe(5);
    expect(d.min_applied).toBe(false);
    expect(d.suggested_buy_qty).toBe(d.eoq_qty);
  });
});
