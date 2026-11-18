/**
 * Buy rules: three guards on the suggested buy, aimed at over-buying.
 *
 * 1. New products buy a trial quantity, not a forecast-sized line.
 * 2. No line may take stock past max_cover_days of demand.
 * 3. Slow sellers (under ~1 sale a month) keep a small fixed stock and
 *    reorder on sale. A monthly unit forecast for them is mostly noise.
 *
 * Pure functions; deriveSkuMetrics applies them in order after the EOQ top-up
 * and before supplier minimums / packs (supplier reality still wins and is
 * flagged by PACK_OVER_CAP).
 */
import type { SkuStats } from './buyer-metrics';

export interface BuyRuleSettings {
  /** No line may take on-hand + inbound + buy past this many days of demand. 0 disables. */
  max_cover_days: number;
  /** A SKU selling fewer units than this per month is a slow seller. 0 disables the rule. */
  slow_seller_monthly_units: number;
  /** Stock a slow seller keeps (on hand + inbound); the buy tops up to it. */
  slow_seller_stock_target: number;
  /** Most a new SKU's line may be beyond what it sold in the last 30 days. 0 disables. */
  new_sku_trial_qty: number;
  /** Days after arrival a new SKU is reviewed for sell-through (NEW_SKU_SLOW). */
  new_sku_review_days: number;
}

export const DEFAULT_BUY_RULE_SETTINGS: BuyRuleSettings = {
  max_cover_days: 120,
  slow_seller_monthly_units: 1,
  slow_seller_stock_target: 2,
  new_sku_trial_qty: 3,
  new_sku_review_days: 45,
};

/** Every unit in stock arrived within this many days, for a SKU to count as new. */
export const NEW_SKU_WINDOW_DAYS = 180;
/** Sell-through below this after the review window flags a new SKU (NEW_SKU_SLOW). */
export const NEW_SKU_SLOW_SELL_THROUGH = 0.25;

type NewSkuStats = Pick<
  SkuStats,
  | 'qty'
  | 'age_of_oldest_item_days'
  | 'avg_daily_sales_30d'
  | 'avg_daily_sales_30_90d'
  | 'avg_daily_sales_90_180d'
  | 'avg_daily_sales_180_270d'
  | 'avg_daily_sales_270_360d'
>;

/**
 * New (or re-launched): no sales in the 90-360 day windows, and every unit in
 * stock arrived inside NEW_SKU_WINDOW_DAYS (or none is in stock). A product
 * that sold years ago and is being bought again counts as new, which is the
 * intent: its old history says nothing about this range.
 */
export function isNewSku(s: NewSkuStats): boolean {
  const oldSales = (s.avg_daily_sales_90_180d || 0) + (s.avg_daily_sales_180_270d || 0) + (s.avg_daily_sales_270_360d || 0);
  if (oldSales > 0) return false;
  const age = s.age_of_oldest_item_days;
  if (age == null) return !(s.qty > 0);
  return age <= NEW_SKU_WINDOW_DAYS;
}

/** Units sold in roughly the last 90 days, from the 30d and 30-90d windows. */
export function recentUnitsSold(s: Pick<SkuStats, 'avg_daily_sales_30d' | 'avg_daily_sales_30_90d'>): number {
  return Math.round((s.avg_daily_sales_30d || 0) * 30 + (s.avg_daily_sales_30_90d || 0) * 60);
}

export interface BuyRuleInput {
  /** The suggested line after the EOQ top-up. */
  qty: number;
  stats: NewSkuStats;
  incoming_next_2m: number;
  /** Expected units a month: the larger of the next 90 days' forecast / 3 and trailing velocity x 30. */
  monthly_demand: number;
  /** Expected units over the next max_cover_days (forecast where trusted, else velocity; uncensored for a truly-out seller). */
  cover_demand_units: number;
  /** The SKU is selling (trailing velocity or forward demand in the next 30 days). */
  selling: boolean;
  /** The SKU has sold at some point (recent windows or all-time). */
  has_history: boolean;
  /** Seasonal/prebook classes are bought via the seasonal panel; rules leave them alone. */
  seasonal_class: boolean;
  settings: BuyRuleSettings;
}

export interface BuyRuleResult {
  qty: number;
  slow_seller: boolean;
  new_sku: boolean;
  /** The trial cap lowered the line. */
  trial_capped: boolean;
  /** The cover cap lowered the line. */
  cover_capped: boolean;
  /** The line before the rules, for "12 -> 3" reasons. */
  pre_rule_qty: number;
}

/**
 * Apply the three rules in order: slow-seller min/max, new-SKU trial cap,
 * cover cap. Every rule only ever LOWERS the line; none conjures a buy.
 */
export function applyBuyRules(i: BuyRuleInput): BuyRuleResult {
  const st = i.settings;
  const onHandInbound = Math.max(0, i.stats.qty) + Math.max(0, i.incoming_next_2m);
  const newSku = isNewSku(i.stats);
  let qty = i.qty;

  const slow =
    !i.seasonal_class &&
    st.slow_seller_monthly_units > 0 &&
    i.has_history &&
    i.selling &&
    !newSku &&
    i.monthly_demand < st.slow_seller_monthly_units;
  if (slow) qty = Math.min(qty, Math.max(0, Math.round(st.slow_seller_stock_target) - onHandInbound));

  let trialCapped = false;
  if (newSku && !i.seasonal_class && st.new_sku_trial_qty > 0 && qty > 0) {
    const cap = Math.max(Math.round(st.new_sku_trial_qty), Math.round((i.stats.avg_daily_sales_30d || 0) * 30));
    if (qty > cap) {
      qty = cap;
      trialCapped = true;
    }
  }

  let coverCapped = false;
  if (!slow && !i.seasonal_class && st.max_cover_days > 0 && qty > 0 && i.cover_demand_units > 0) {
    const room = Math.max(0, Math.floor(i.cover_demand_units) - onHandInbound);
    if (qty > room) {
      qty = room;
      coverCapped = true;
    }
  }

  return { qty, slow_seller: slow, new_sku: newSku, trial_capped: trialCapped, cover_capped: coverCapped, pre_rule_qty: i.qty };
}

// ── Exceptions ─────────────────────────────────────────────────────────────

export interface RuleRow {
  sku: string;
  stats: NewSkuStats & Pick<SkuStats, 'unit_cost' | 'incoming'>;
  derived: { new_sku: boolean; cover_demand_units: number; seasonal_class: boolean };
}

export interface RuleExceptionHit {
  sku: string;
  /** NEW_SKU_SLOW: units on hand. OVERBUY_ON_ORDER: units past the cover cap. */
  units: number;
  /** Cost of those units; null when the SKU has no recorded cost. */
  cost: number | null;
}

/**
 * New SKUs past the review window whose sell-through is under 25%: markdown
 * or return candidates, and a sign the trial buy was too deep.
 */
export function newSkusNotSelling(rows: RuleRow[], settings: BuyRuleSettings): RuleExceptionHit[] {
  const out: RuleExceptionHit[] = [];
  for (const r of rows) {
    const s = r.stats;
    if (!r.derived.new_sku || r.derived.seasonal_class || !(s.qty > 0)) continue;
    const age = s.age_of_oldest_item_days;
    if (age == null || age < settings.new_sku_review_days) continue;
    const sold = recentUnitsSold(s);
    if (sold / (sold + s.qty) >= NEW_SKU_SLOW_SELL_THROUGH) continue;
    out.push({ sku: r.sku, units: s.qty, cost: s.unit_cost != null ? s.unit_cost * s.qty : null });
  }
  return out;
}

/**
 * Established SKUs whose stock plus everything on order runs past
 * max_cover_days of demand: a PO placed deeper than policy, caught while it
 * can still be cut. Overdue lines count here (they are still on the PO).
 */
export function overbuyOnOrder(rows: RuleRow[], settings: BuyRuleSettings): RuleExceptionHit[] {
  const out: RuleExceptionHit[] = [];
  if (!(settings.max_cover_days > 0)) return out;
  for (const r of rows) {
    const s = r.stats;
    if (r.derived.new_sku || r.derived.seasonal_class || !(s.incoming > 0)) continue;
    const allowed = Math.floor(r.derived.cover_demand_units);
    const excess = Math.min(s.incoming, Math.max(0, s.qty) + s.incoming - allowed);
    if (excess <= 0) continue;
    out.push({ sku: r.sku, units: excess, cost: s.unit_cost != null ? s.unit_cost * excess : null });
  }
  return out;
}
