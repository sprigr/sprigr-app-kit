/**
 * buying-core - performance tiers.
 *
 * Sorts products into tiers from figures the caller already has (units sold,
 * gross profit, stock, the velocity windows) and from ad spend and exposure
 * when the caller supplies them. Each tier may carry a role the buy plan and
 * the EOQ guard read: 'priority' or 'run_down'. Pure, no clock: every figure
 * is over the caller's own window.
 */

import { isNewSku, DEFAULT_BUY_RULE_SETTINGS } from './buy-rules';
import { DEFAULT_BUYER_SETTINGS, isDead, weightedVelocity, type LabelRole, type SkuStats } from './buyer-metrics';
import { reason, type Reason } from './reason-codes';

export type PerformanceTier =
  | 'run_down'
  | 'new'
  | 'proven'
  | 'promising'
  | 'underperforming'
  | 'tested_no_sale'
  | 'no_evidence';

/** One product over the caller's window. Money is in store currency. */
export interface PerformanceRow
  extends Pick<
    SkuStats,
    | 'qty'
    | 'age_of_oldest_item_days'
    | 'avg_daily_sales_30d'
    | 'avg_daily_sales_30_90d'
    | 'avg_daily_sales_90_180d'
    | 'avg_daily_sales_180_270d'
    | 'avg_daily_sales_270_360d'
  > {
  sku: string;
  /** Products are ranked within their class; empty or absent = one shared group. */
  class_1?: string | null;
  units_sold: number;
  /** Revenue minus cost of goods. */
  gross_profit: number;
  revenue: number;
  /** On-hand units x unit cost; null when the product is uncosted. */
  stock_cost: number | null;
  /** How often the product was shown (ad clicks, product views, any count). */
  exposure?: number | null;
  ad_cost?: number | null;
  /** All-time figures, read only by the tested_no_sale tier. */
  lifetime_units_sold?: number | null;
  lifetime_exposure?: number | null;
}

export interface PerformanceOptions {
  /** Units sold needed to judge a product. Default 2: one sale can be chance. */
  min_units: number;
  /** Exposure needed to judge a product that reports exposure. Default 0 (off). */
  min_exposure: number;
  /**
   * Gross profit per unit of ad spend that counts as a strong return.
   * Default 1.0: the ad spend is paid back in gross profit.
   */
  min_return_on_ad_spend: number;
  /**
   * With no ad spend, the share of its class a product must out-earn on gross
   * profit to count as strong. Default 0.8: the top fifth of the class.
   */
  priority_percentile: number;
  /**
   * Lifetime exposure after which a product that never sold is tested_no_sale.
   * Default 0 (off): the tier never fires until the caller sets it.
   */
  tested_exposure: number;
  /** The word for exposure in reason text. Default 'exposure'. */
  exposure_kind: string;
  /** Weights of the three velocity windows, as BuyerSettings.velocity_weights. Default [0.5, 0.3, 0.2]. */
  velocity_weights: readonly [number, number, number];
  /** Age window of a new product, as BuyRuleSettings.new_sku_window_days. Default 180. */
  new_sku_window_days: number;
}

export const DEFAULT_PERFORMANCE_OPTIONS: PerformanceOptions = {
  min_units: 2,
  min_exposure: 0,
  min_return_on_ad_spend: 1.0,
  priority_percentile: 0.8,
  tested_exposure: 0,
  exposure_kind: 'exposure',
  velocity_weights: DEFAULT_BUYER_SETTINGS.velocity_weights,
  new_sku_window_days: DEFAULT_BUY_RULE_SETTINGS.new_sku_window_days,
};

export interface PerformanceMetrics {
  /** 'ad' when the row has ad spend, else 'rank' (gross profit rank within the class). */
  mode: 'ad' | 'rank';
  units_sold: number;
  gross_profit: number;
  revenue: number;
  stock_cost: number | null;
  /** Gross profit per unit of ad spend; null in rank mode. */
  return_on_ad_spend: number | null;
  /** Share of the other rows in the class this row out-earns, 0..1; 1 when it is alone. */
  class_percentile: number;
  velocity: number;
}

export interface PerformanceResult {
  sku: string;
  tier: PerformanceTier;
  /** The role the buy plan and the EOQ guard read; null when the tier has none. */
  role: LabelRole | null;
  reasons: Reason[];
  metrics: PerformanceMetrics;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

const TIER_ROLE: Record<PerformanceTier, LabelRole | null> = {
  run_down: 'run_down',
  new: null,
  proven: 'priority',
  promising: null,
  underperforming: null,
  tested_no_sale: 'run_down',
  no_evidence: null,
};

/**
 * Tier every row. Tiers are checked in a fixed order and the first match
 * wins: run_down, new, proven, promising, underperforming, tested_no_sale,
 * no_evidence. Dead and new use the package's own isDead and isNewSku, so a
 * product is never judged twice by two rules.
 */
export function classifyPerformance(
  rows: readonly PerformanceRow[],
  options?: Partial<PerformanceOptions>,
): PerformanceResult[] {
  const opt: PerformanceOptions = { ...DEFAULT_PERFORMANCE_OPTIONS };
  if (options) {
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined) (opt as unknown as Record<string, unknown>)[k] = v;
    }
  }

  const byClass = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.class_1 ?? '';
    const list = byClass.get(key);
    if (list) list.push(row.gross_profit);
    else byClass.set(key, [row.gross_profit]);
  }
  const percentileOf = (row: PerformanceRow): number => {
    const peers = byClass.get(row.class_1 ?? '') ?? [];
    if (peers.length <= 1) return 1;
    let lower = 0;
    for (const gp of peers) if (gp < row.gross_profit) lower++;
    return lower / (peers.length - 1);
  };

  return rows.map((row) => {
    const velocity = weightedVelocity(row, opt.velocity_weights);
    const adCost = row.ad_cost != null && row.ad_cost > 0 ? row.ad_cost : null;
    const percentile = percentileOf(row);
    const ret = adCost != null ? r2(row.gross_profit / adCost) : null;
    const metrics: PerformanceMetrics = {
      mode: adCost != null ? 'ad' : 'rank',
      units_sold: row.units_sold,
      gross_profit: row.gross_profit,
      revenue: row.revenue,
      stock_cost: row.stock_cost,
      return_on_ad_spend: ret,
      class_percentile: r2(percentile),
      velocity,
    };
    const done = (tier: PerformanceTier, reasons: Reason[]): PerformanceResult => ({
      sku: row.sku,
      tier,
      role: TIER_ROLE[tier],
      reasons,
      metrics,
    });

    if (isDead(row.qty, velocity)) {
      return done('run_down', [
        reason('DEAD_STOCK', `${row.qty} units on hand, no sales across the velocity windows`, row.qty),
      ]);
    }
    if (isNewSku(row, opt.new_sku_window_days)) {
      return done('new', [reason('NEW_SKU_TRIAL', 'new or re-launched: not judged yet')]);
    }

    const enough =
      row.units_sold >= opt.min_units && (row.exposure == null || row.exposure >= opt.min_exposure);
    const strong =
      ret != null
        ? ret >= opt.min_return_on_ad_spend
        : percentile >= opt.priority_percentile && row.gross_profit > 0;
    const weak = ret != null ? ret < opt.min_return_on_ad_spend : row.gross_profit <= 0;
    const pct = Math.round(percentile * 100);
    const strongText =
      ret != null
        ? `gross profit ${ret} per 1.00 of ad spend (bar ${opt.min_return_on_ad_spend})`
        : `gross profit ${r2(row.gross_profit)} at the ${pct}th percentile of its class`;
    const strongValue = ret != null ? ret : pct;

    if (enough && strong) {
      return done('proven', [reason('PERF_PROVEN', `${strongText}, ${row.units_sold} units`, strongValue)]);
    }
    if (strong) {
      const short =
        row.units_sold < opt.min_units
          ? `${row.units_sold} units, floor ${opt.min_units}`
          : `${row.exposure} ${opt.exposure_kind}, floor ${opt.min_exposure}`;
      return done('promising', [
        reason('PERF_PROMISING', `${strongText}; evidence under the floor (${short})`, strongValue),
      ]);
    }
    if (enough && weak) {
      const reasons: Reason[] = [
        ret != null
          ? reason(
              'PERF_UNDERPERFORMING',
              `gross profit ${ret} per 1.00 of ad spend under the bar of ${opt.min_return_on_ad_spend}, ${row.units_sold} units`,
              ret,
            )
          : reason(
              'PERF_UNDERPERFORMING',
              `gross profit ${r2(row.gross_profit)} on ${row.units_sold} units`,
              row.gross_profit,
            ),
      ];
      if (adCost != null) {
        reasons.push(reason('AD_WASTE', `ad spend ${r2(adCost)} on an underperforming SKU`, adCost));
      }
      return done('underperforming', reasons);
    }
    if (
      opt.tested_exposure > 0 &&
      row.lifetime_exposure != null &&
      row.lifetime_exposure >= opt.tested_exposure &&
      row.lifetime_units_sold === 0
    ) {
      return done('tested_no_sale', [
        reason('PERF_TESTED_NO_SALE', `${row.lifetime_exposure} ${opt.exposure_kind} and no sale`, row.lifetime_exposure),
      ]);
    }
    return done('no_evidence', [reason('PERF_NO_EVIDENCE', `not enough to judge: ${row.units_sold} units`)]);
  });
}
