/**
 * buying-core - the single source of truth for every derived buyer metric.
 *
 * Pure functions only: no I/O, no database, no Date.now(). Every caller that
 * shows a figure runs the SAME functions, so two readers of one SKU can never
 * disagree. Derived figures are computed AT READ TIME from raw inputs and are
 * never persisted.
 *
 * Every formula below is an approximation of a buyer's manual ordering method
 * and is documented at the definition. Change a formula HERE and nowhere else.
 */

import { reason, type Reason } from './reason-codes';
import { brandKey, brandLookup } from './brand-key';
import { applyBuyRules, DEFAULT_BUY_RULE_SETTINGS, type BuyRuleSettings } from './buy-rules';

// ── Input shapes ─────────────────────────────────────────────────────────

/**
 * Per-SKU stats as the caller supplies them. The avg_daily_sales_* windows are
 * rolling units/day figures.
 */
export interface SkuStats {
  sku: string;
  /** The product's brand attribute; empty when it has none. */
  brand: string;
  class_1: string;
  category: string;
  rrp: number;
  /** Per-unit supplier cost; null when not recorded. */
  unit_cost: number | null;
  /** Stock on hand (units). */
  qty: number;
  /** Total incoming units on order (all ETAs). */
  incoming: number;
  age_of_oldest_item_days: number | null;
  avg_daily_sales_30d: number;
  avg_daily_sales_30_90d: number;
  avg_daily_sales_90_180d: number;
  avg_daily_sales_180_270d: number;
  avg_daily_sales_270_360d: number;
  avg_daily_sales_all_time: number;
  avg_sale_price_30d: number | null;
  avg_sale_price_30_90d: number | null;
  avg_sale_price_90_180d: number | null;
  avg_sale_price_all_time: number | null;
  /**
   * Optional profitability level (1 = least
   * profitable). 0 / absent = no tier assigned → no coverage adjustment.
   */
  profitability_level?: number;
  // ── Marketplace saleability ─────────────────────────────────────
  /**
   * Current marketplace / dropship stock on hand (units); null when the
   * caller's input does not carry it. When null, resolveSaleability uses the
   * fallback marketplace stock figure the caller may pass. `qty` above is
   * OWN stock only, so own-stock 0 does NOT mean the SKU is unsaleable.
   */
  marketplace_soh?: number | null;
  /**
   * Current "is this SKU sellable right now" flag. 1 = saleable, 0 = not,
   * null when the caller's input does not carry it. An explicit 0 is
   * AUTHORITATIVE unsaleable: with no own stock it resolves TRULY_OUT and is
   * never outvoted by the (possibly stale) fallback figure. An
   * explicit 1 with own stock 0 is MARKETPLACE_ONLY even when marketplace_soh
   * is unknown.
   */
  is_saleable?: number | null;
  // ── Pack / minimum order quantities ─────────────────────────────
  /**
   * The row's per-SKU reorder quantity: the supplier pack / minimum the store
   * has always ordered in. NULL-tolerant - null or 0 = unset. A buyer-set
   * per-SKU pack_qty override always beats this value; see
   * resolveEffectivePack.
   */
  reorder_qty?: number | null;
}

// ── Three-state saleability ──────────────────────────────────────
//
// Own-stock qty 0 does NOT mean a SKU is unsaleable: marketplace / dropship
// stock may still be selling it. A flat STOCKOUT flag (qty<=0 && selling)
// mislabels those, overstating revenue-loss and ad-waste and mis-prioritising
// buys. This resolves ONE saleability state per SKU that every downstream
// reader uses, so a risk tier, a revenue-loss line and a buy reason can never
// disagree about whether a SKU is really out.

export type SaleabilityState =
  /** Own stock <= 0 AND no marketplace evidence (mp soh <=0/absent with is_saleable 0). Truly out. */
  | 'TRULY_OUT'
  /** Own stock <= 0 but marketplace stock > 0 OR is_saleable=1. Sales continue via marketplace. */
  | 'MARKETPLACE_ONLY'
  /** Own stock > 0. Fulfilled from own warehouse. */
  | 'IN_STOCK';

/** The resolved saleability of one SKU, plus which evidence decided it. */
export interface Saleability {
  state: SaleabilityState;
  /**
   * True when NO marketplace evidence exists at all (marketplace_soh AND
   * is_saleable AND the fallback figure are ALL null). In this case
   * the resolution degrades to exact own-stock-only semantics
   * (state TRULY_OUT when own qty<=0, IN_STOCK otherwise) so the feature is a
   * no-op for a caller that supplies no marketplace data.
   */
  no_marketplace_evidence: boolean;
  /** The marketplace SOH actually used (the row's current figure, else the fallback, else null). */
  marketplace_soh: number | null;
}

/**
 * Resolve the three-state saleability for one SKU from its own stock plus the
 * available marketplace evidence. Evidence precedence:
 *   1. a current is_saleable=0 on the row is AUTHORITATIVE unsaleable:
 *      with own stock 0 the SKU is TRULY_OUT, and neither the fallback figure
 *      nor a current marketplace SOH reading outvotes it;
 *   2. the row's current marketplace_soh (when present) decides
 *      marketplace stock; an explicit is_saleable=1 also means the SKU IS
 *      sellable (MARKETPLACE_ONLY when own stock is 0 even with no soh number);
 *   3. a fallback marketplace stock figure the caller may pass
 *      (fallback_marketplace_soh) is consulted ONLY when the row gave nothing
 *      at all (marketplace_soh AND is_saleable both null) - it may be stale,
 *      so any current signal beats it.
 *
 * When ALL three are null there is NO marketplace evidence: the result is
 * exact own-stock-only semantics, and no_marketplace_evidence is set so the
 * caller knows this SKU degraded to them.
 */
export function resolveSaleability(args: {
  own_qty: number;
  /** Current marketplace SOH on the row; null when the caller's input does not carry it. */
  marketplace_soh?: number | null;
  /** Current saleability flag on the row; null when absent. */
  is_saleable?: number | null;
  /** A fallback marketplace stock figure the caller may pass (possibly stale); null when unknown. */
  fallback_marketplace_soh?: number | null;
}): Saleability {
  const liveMp = args.marketplace_soh ?? null;
  const isSaleable = args.is_saleable ?? null;
  const fallbackMp = args.fallback_marketplace_soh ?? null;

  // The marketplace SOH we actually trust: the row's current figure first. The
  // fallback (possibly stale) is consulted ONLY when the row gave us nothing
  // at all - neither a current SOH nor a current saleability flag. An
  // explicit is_saleable=0 is authoritative "unsaleable": a stale positive
  // fallback must never outvote it (or a genuinely-out SKU loses its STOCKOUT
  // urgency, drops off revenue-loss, and misses the censoring fix).
  const mpSoh = liveMp != null ? liveMp : isSaleable == null ? fallbackMp : null;

  const noEvidence = liveMp == null && isSaleable == null && fallbackMp == null;

  // Own stock present: always IN_STOCK regardless of marketplace evidence.
  if (args.own_qty > 0) {
    return { state: 'IN_STOCK', no_marketplace_evidence: noEvidence, marketplace_soh: mpSoh };
  }

  // No marketplace evidence at all: exact own-stock-only semantics.
  if (noEvidence) {
    return { state: 'TRULY_OUT', no_marketplace_evidence: true, marketplace_soh: null };
  }

  // Own stock 0, some marketplace evidence exists. A current is_saleable=0 is
  // authoritative unsaleable; otherwise marketplace stock (current, or the
  // fallback when no current signal exists) or an explicit is_saleable=1 means
  // sales continue via the marketplace.
  const marketplaceSelling = isSaleable === 0 ? false : (mpSoh != null && mpSoh > 0) || isSaleable === 1;
  return {
    state: marketplaceSelling ? 'MARKETPLACE_ONLY' : 'TRULY_OUT',
    no_marketplace_evidence: false,
    marketplace_soh: mpSoh,
  };
}

/**
 * Which coverage figure drives risk + suggested buys. 'forward_auto' (the
 * default) uses forecast-based forward cover for any SKU whose 12-month grid
 * carries demand and falls back to trailing velocity otherwise; 'trailing'
 * forces trailing-velocity cover everywhere (calibration escape hatch).
 */
export type RiskBasis = 'forward_auto' | 'trailing';

/** Buyer policy knobs, resolved from stored settings over code defaults. Buy rules live in buy-rules.ts. */
export interface BuyerSettings extends BuyRuleSettings {
  coverage_target_default_days: number;
  lead_time_default_days: number;
  /** Per-brand coverage-target overrides in days, keyed by brandKey(the row's brand). */
  brand_coverage_overrides: Record<string, number>;
  /** Per-brand lead-time overrides in days (an overseas maker is months, a local distributor days). */
  brand_lead_time_overrides: Record<string, number>;
  /** Per-class coverage-target overrides in days. */
  class_coverage_overrides: Record<string, number>;
  /** Per-class lead-time overrides in days. */
  class_lead_time_overrides: Record<string, number>;
  /**
   * Profitability coverage-adjust curve: level → fractional adjustment to the
   * coverage target, on the caller's own level scale (for example
   * { '1': -0.15, '4': -1 }: an entry of -1 targets 0 days, so that level is
   * never re-bought). Default {} (no adjustment).
   */
  profitability_coverage_adjust: Record<string, number>;
  risk_basis: RiskBasis;
  /**
   * Class names bought seasonally / prebook rather than continuously
   * replenished. SKUs in these classes are kept OUT of the reorder queue
   * (bought outside it), so a flat off-season forecast can't push a seasonal
   * line onto the buy list. Default [] (no class is seasonal).
   */
  seasonal_classes: string[];
  /**
   * Weights of the blended velocity over the three trailing windows
   * [avg_daily_sales_30d, avg_daily_sales_30_90d, avg_daily_sales_90_180d].
   * Default [0.5, 0.3, 0.2].
   */
  velocity_weights: [number, number, number];
  /** |trend_pct| at or past this fraction is called out as a reason. Default 0.25. */
  trend_reason_threshold: number;
  /**
   * Forward cover below this fraction of trailing cover is called out as a
   * peak ahead (SEASON_PEAK_AHEAD). Default 0.75.
   */
  season_peak_ratio: number;
  /**
   * Forward cover above this multiple of trailing cover is called out as a
   * slowdown ahead (SEASON_SLOWDOWN_AHEAD). Default 1.33.
   */
  season_slowdown_ratio: number;
  /**
   * Aged-stock thresholds in days, [first, second]: an oldest item past the
   * first is aged, past the second is in the oldest bucket. Default [90, 180].
   */
  aged_days: [number, number];
  // ── EOQ line quantities ────────────────────────────────────────
  /**
   * Master switch for the economic-order-quantity top-up. When false the
   * suggested buy is exactly the coverage-fill figure;
   * when true a nonzero base suggestion is raised to the EOQ where the EOQ is
   * larger, so the buyer stops paying fixed receiving labour on qty-1 lines.
   * Default true; the top-up also needs handling_cost_per_line.
   */
  eoq_enabled: boolean;
  /**
   * K in the EOQ formula: the fixed handling cost of putting ONE order line
   * away - receiving, unpacking, binning, the paperwork. In store currency.
   * Bigger K => bigger economic batch (fewer, larger buys). No default: it is
   * the caller's own cost, and absent means no EOQ top-up.
   */
  handling_cost_per_line?: number;
  /**
   * Unit cost (store currency) used ONLY for the EOQ holding term when a SKU
   * has no recorded cost. It never feeds order_cost or any money figure, only
   * the batch size. No default: absent means an unpriced SKU gets no EOQ
   * top-up.
   */
  eoq_fallback_unit_cost?: number;
  /**
   * h_rate in the EOQ formula: the ANNUAL holding cost as a fraction of a
   * unit's landed cost (capital + storage + obsolescence). h = h_rate x
   * unit_cost. Bigger h_rate => smaller economic batch (expensive stock is
   * costly to hold, so buy it thinner). Default 0.25 (25%/yr).
   */
  holding_rate_annual: number;
  /**
   * The EOQ top-up may never push a line past this many days of FORWARD cover.
   * A cheap-slow SKU has a huge raw EOQ (sqrt blows up as h -> 0); this caps
   * the raise at "units covering eoq_max_cover_days of demand" so the buyer
   * never ends up with years of stock in a low-cost line. Default 180.
   */
  eoq_max_cover_days: number;
}

/** Code defaults - used for any key not explicitly set in stored settings. */
export const DEFAULT_BUYER_SETTINGS: BuyerSettings = {
  coverage_target_default_days: 30,
  lead_time_default_days: 14,
  brand_coverage_overrides: {},
  brand_lead_time_overrides: {},
  class_coverage_overrides: {},
  class_lead_time_overrides: {},
  profitability_coverage_adjust: {},
  risk_basis: 'forward_auto',
  seasonal_classes: [],
  velocity_weights: [0.5, 0.3, 0.2],
  trend_reason_threshold: 0.25,
  season_peak_ratio: 0.75,
  season_slowdown_ratio: 1.33,
  aged_days: [90, 180],
  eoq_enabled: true,
  holding_rate_annual: 0.25,
  eoq_max_cover_days: 180,
  ...DEFAULT_BUY_RULE_SETTINGS,
};

export type StockoutRisk = 'STOCKOUT' | 'High' | 'Medium' | 'Low';

/**
 * The forward view of one SKU: the 12-month forecast row plus how much of the
 * current month is still ahead. month0_fraction is (remaining days incl.
 * today) / (days in month) - the caller computes it from as_of so this module
 * stays clock-free.
 */
export interface ForwardInput {
  /** Forecast unit sales, forecast[0..11], index 0 = the current month. */
  forecast: number[];
  /** Fraction of the current month still ahead, (0, 1]. */
  month0_fraction: number;
}

/** Everything derived for one SKU. Never persisted. */
export interface DerivedSkuMetrics {
  sku: string;
  brand: string;
  weighted_velocity: number;
  /** Days of cover at the blended velocity; null when velocity is 0. */
  coverage_days: number | null;
  /**
   * Days of cover against the FORWARD forecast (walking forecast[0..11]); null when
   * no forecast demand exists in the horizon. Values at the horizon cap
   * (~365) mean "at least this much".
   */
  forward_coverage_days: number | null;
  /** Which cover figure drove risk + suggested buy for this SKU. */
  basis: 'forward' | 'trailing';
  /** Effective coverage target after brand override + profitability adjust. */
  coverage_target_days: number;
  /** coverage_target - coverage_days; null when coverage_days is null. */
  coverage_gap_days: number | null;
  lead_time_days: number;
  stockout_risk: StockoutRisk;
  // ── Saleability ─────────────────────────────────────────────────
  /**
   * Three-state saleability: TRULY_OUT | MARKETPLACE_ONLY | IN_STOCK. STOCKOUT
   * risk is reserved for TRULY_OUT-and-selling; a MARKETPLACE_ONLY-and-selling
   * SKU is at risk of the same tier but is fulfilled from marketplace stock, so
   * it must NOT count as a STOCKOUT (mp_only_selling is set instead).
   */
  saleability: SaleabilityState;
  /** The marketplace SOH used for the resolution (the row's current figure or the fallback); null when unknown. */
  marketplace_soh: number | null;
  /**
   * True when the SKU is out of own stock, still selling, but fulfilled from
   * marketplace/dropship stock (state MARKETPLACE_ONLY with demand). A
   * distinct tier: NOT a true stockout.
   */
  mp_only_selling: boolean;
  /** No recent sales but stock still sitting - excluded from the reorder queue. */
  is_dead: boolean;
  /** In the reorder queue: at-risk (STOCKOUT/High) and not dead. */
  reorder: boolean;
  /** 30d velocity vs 30-90d velocity, as a fraction; null when 30-90d is 0. */
  trend_pct: number | null;
  suggested_buy_qty: number;
  // ── EOQ line quantity ──────────────────────────────────────────
  /**
   * The coverage-fill suggestion BEFORE the EOQ top-up. Equals
   * suggested_buy_qty when EOQ did not raise the line.
   */
  eoq_base_qty: number;
  /**
   * The economic order quantity the line was raised TO (equals eoq_base_qty
   * when EOQ didn't fire). Lets a reader show "1 -> 4" without re-deriving.
   * 0 when there is no base suggestion. This is the PRE-pack
   * figure: pack rounding (below) may lift suggested_buy_qty further.
   */
  eoq_qty: number;
  /** True when the EOQ top-up genuinely raised the line above eoq_base_qty. */
  eoq_applied: boolean;
  // ── Minimum order + pack quantities ──────────────
  /**
   * The effective minimum order quantity (floor) in force for this SKU (the
   * buyer's per-SKU override); null when unset. A nonzero suggestion is lifted
   * to at least this before pack rounding. Exposed even when the suggestion is 0
   * so a reader can show "min order N".
   */
  min_order_qty: number | null;
  /**
   * The effective pack size (the multiple) in force for this SKU (buyer override
   * first, else the row's reorder_qty); null when neither is set. Exposed
   * even when the suggestion is 0 so a reader can show "orders in packs of N".
   */
  pack_qty: number | null;
  /** Where the effective pack came from: the buyer's per-SKU override or the row's reorder_qty. */
  pack_source: 'override' | 'input' | null;
  /** True when the minimum order quantity floor lifted the line quantity. */
  min_applied: boolean;
  /**
   * The line quantity BEFORE pack rounding but AFTER the min floor (the
   * post-EOQ, post-min figure). Lets a reader show "10 -> 15 (pack of 5)"
   * without re-deriving.
   */
  pre_pack_qty: number;
  /** True when pack rounding genuinely changed the line quantity. */
  pack_applied: boolean;
  /**
   * True when the min or pack push landed the line past the EOQ cover cap
   * (eoq_max_cover_days of demand). Supplier reality wins - the buy stays at
   * the constraint - but the overshoot is flagged (reason PACK_OVER_CAP).
   */
  pack_over_cap: boolean;
  /** Annual demand units (D) used for the EOQ + trips math; 0 when unknown. */
  eoq_annual_demand: number;
  /**
   * True when demand-censoring correction fired: for a TRULY_OUT seller,
   * the trailing-velocity demand figure beat the (censored) forward figure AND
   * that changed the buy outcome. See resolveDemandBasis.
   */
  demand_uncensored: boolean;
  /** Incoming units with an ETA inside the next ~2 months (input, echoed). */
  incoming_next_2m: number;
  /** Seasonal/prebook class: kept out of the reorder queue. */
  seasonal_class: boolean;
  /** Forecast shows demand but the SKU has never sold - the buy was suppressed. */
  forecast_only: boolean;
  /** Expected units over the next max_cover_days (forward where trusted, else velocity; uncensored for a truly-out seller). */
  cover_demand_units: number;
  /** Expected units a month: max(next 90 days' forecast / 3, trailing velocity x 30). Drives the slow-seller rule. */
  monthly_demand: number;
  /** Buy rules (buy-rules.ts): the line after the rules and before supplier minimums/packs. */
  rule_qty: number;
  /** Slow seller (under slow_seller_monthly_units a month): kept at slow_seller_stock_target, reorder on sale. */
  slow_seller: boolean;
  /** New or re-launched SKU (no sales 90-360 days ago, stock all arrived inside new_sku_window_days). */
  new_sku: boolean;
  /** The new-SKU trial cap lowered the line. */
  trial_capped: boolean;
  /** The max_cover_days cap lowered the line. */
  cover_capped: boolean;
}

// ── Primitive formulas (documented, single-definition) ───────────────────

/**
 * Blended sales velocity in units/day.
 *
 * Approximation: recent windows carry the most weight when sizing orders. We
 * blend avg_daily_sales_30d, avg_daily_sales_30_90d and
 * avg_daily_sales_90_180d by `weights` (in that order) so one hot or dead
 * month doesn't whipsaw the buy suggestion. Callers with settings pass
 * settings.velocity_weights; absent, the default [0.5, 0.3, 0.2] applies.
 */
export function weightedVelocity(
  s: {
    avg_daily_sales_30d: number;
    avg_daily_sales_30_90d: number;
    avg_daily_sales_90_180d: number;
  },
  weights: readonly [number, number, number] = DEFAULT_BUYER_SETTINGS.velocity_weights,
): number {
  const v =
    weights[0] * (s.avg_daily_sales_30d || 0) +
    weights[1] * (s.avg_daily_sales_30_90d || 0) +
    weights[2] * (s.avg_daily_sales_90_180d || 0);
  return v > 0 ? v : 0;
}

/** Last day covered by each trailing velocity window, in velocity_weights order. */
const VELOCITY_WINDOW_END_DAYS = [30, 90, 180] as const;

/**
 * Days of sales history the blended velocity looks back over: the end of the
 * furthest window carrying a positive weight (all windows when none does).
 */
function velocityLookbackDays(weights: readonly [number, number, number]): number {
  for (let i = VELOCITY_WINDOW_END_DAYS.length - 1; i >= 0; i--) {
    if ((weights[i] ?? 0) > 0) return VELOCITY_WINDOW_END_DAYS[i]!;
  }
  return VELOCITY_WINDOW_END_DAYS[VELOCITY_WINDOW_END_DAYS.length - 1]!;
}

/**
 * coverage_days = qty / weighted_velocity.
 * Div-0 guard: when velocity is 0 there is no meaningful coverage figure
 * (stock lasts "forever") → null, never Infinity/NaN.
 */
export function coverageDays(qty: number, velocity: number): number | null {
  if (!Number.isFinite(velocity) || velocity <= 0) return null;
  return Math.max(0, qty) / velocity;
}

/** Month length convention for the forecast walk (forecast entries are month buckets). */
export const FORECAST_MONTH_DAYS = 30;

/**
 * Forward days of cover: walk the monthly forecast consuming stock month by
 * month (month 0 pro-rated by month0_fraction) and return the days until the
 * stock runs out. Zero-demand months pass in full (stock keeps). Reaching the
 * end of the horizon with stock left returns the horizon's day count - read
 * it as "at least this much". null when the horizon carries no demand at all
 * (no forward figure is meaningful - mirrors trailing's zero-velocity null).
 */
export function forwardCoverageDays(qty: number, fwd: ForwardInput): number | null {
  const frac = Math.min(1, Math.max(0, fwd.month0_fraction));
  let demandTotal = 0;
  for (let m = 0; m < fwd.forecast.length; m++) {
    demandTotal += Math.max(0, fwd.forecast[m] ?? 0) * (m === 0 ? frac : 1);
  }
  if (!(demandTotal > 0)) return null;
  let stock = Math.max(0, qty);
  let days = 0;
  for (let m = 0; m < fwd.forecast.length; m++) {
    const scale = m === 0 ? frac : 1;
    const monthDays = FORECAST_MONTH_DAYS * scale;
    if (monthDays <= 0) continue;
    const demand = Math.max(0, fwd.forecast[m] ?? 0) * scale;
    if (demand <= 0) {
      days += monthDays;
      continue;
    }
    if (stock >= demand) {
      stock -= demand;
      days += monthDays;
      continue;
    }
    return days + (stock / demand) * monthDays;
  }
  return days;
}

/**
 * Forecast unit demand over the next windowDays (month 0 pro-rated, partial
 * trailing month pro-rated). The forward analogue of velocity * windowDays.
 */
export function forecastUnitsWindow(fwd: ForwardInput, windowDays: number): number {
  const frac = Math.min(1, Math.max(0, fwd.month0_fraction));
  let remaining = Math.max(0, windowDays);
  let units = 0;
  for (let m = 0; m < fwd.forecast.length && remaining > 0; m++) {
    const scale = m === 0 ? frac : 1;
    const monthDays = FORECAST_MONTH_DAYS * scale;
    if (monthDays <= 0) continue;
    const demand = Math.max(0, fwd.forecast[m] ?? 0) * scale;
    const take = Math.min(1, remaining / monthDays);
    units += demand * take;
    remaining -= monthDays;
  }
  return units;
}

/**
 * Profitability coverage adjustment for a level, from the curve.
 * Resolution: the largest defined level <= the SKU's level (so a level above
 * the curve's last entry uses that entry). Level 0 / unset, or an empty
 * curve → 0.
 * Returned fraction is clamped to [-1, 0]: the curve can only REDUCE coverage.
 */
export function profitabilityAdjust(curve: Record<string, number>, level: number | undefined): number {
  if (!level || !Number.isFinite(level) || level <= 0) return 0;
  let best: number | null = null;
  let bestLevel = -Infinity;
  for (const [k, v] of Object.entries(curve)) {
    const kl = Number(k);
    if (!Number.isFinite(kl) || kl > level) continue;
    if (kl > bestLevel) {
      bestLevel = kl;
      best = v;
    }
  }
  if (best == null || !Number.isFinite(best)) return 0;
  return Math.min(0, Math.max(-1, best));
}

/** First positive finite number in the list, else undefined. */
function firstPositive(...values: Array<number | undefined>): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/**
 * A brand override for one row: keys are stored under brandKey, so match the
 * row's brand attribute case-insensitively ("Brand B" -> "BRAND B"). An empty
 * brand matches no override.
 */
function brandOverride(map: Record<string, number>, brand: string): number | undefined {
  return brand ? firstPositive(brandLookup(map, brand)) : undefined;
}

/**
 * The effective coverage target for a SKU:
 *   base  = per-brand override, else per-class override, else default
 *   final = base * (1 + profitability adjustment), floored at 0.
 * A level whose curve entry is -100% targets 0 days of cover, i.e. it
 * is never suggested for re-buy. Brand beats class: the brand override
 * is the sharper (supplier-shaped) knob, the class override the class
 * default.
 */
export function resolveCoverageTarget(
  settings: BuyerSettings,
  brand: string,
  profitabilityLevel: number | undefined,
  classKey?: string,
): number {
  const base =
    firstPositive(
      brandOverride(settings.brand_coverage_overrides, brand),
      classKey ? settings.class_coverage_overrides[classKey] : undefined,
    ) ?? settings.coverage_target_default_days;
  const adj = profitabilityAdjust(settings.profitability_coverage_adjust, profitabilityLevel);
  return Math.max(0, base * (1 + adj));
}

/**
 * The effective resupply lead time for a SKU: per-brand override, else
 * per-class override, else the default. Same precedence as coverage.
 */
export function resolveLeadTime(settings: BuyerSettings, brand: string, classKey?: string): number {
  return (
    firstPositive(
      brandOverride(settings.brand_lead_time_overrides, brand),
      classKey ? settings.class_lead_time_overrides[classKey] : undefined,
    ) ?? settings.lead_time_default_days
  );
}

/** coverage_gap = coverage_target - coverage_days; null when coverage is null. */
export function coverageGap(coverageTargetDays: number, coverage: number | null): number | null {
  if (coverage == null) return null;
  return coverageTargetDays - coverage;
}

/**
 * Dead stock: units on hand but no sales across the
 * blended velocity windows, i.e. weighted velocity is 0. A SKU
 * with neither stock nor sales is merely inactive, not dead.
 */
export function isDead(qty: number, velocity: number): boolean {
  return qty > 0 && velocity <= 0;
}

/**
 * Reorder flag: the SKU belongs in the buyer's queue when it is at risk
 * (STOCKOUT or High) and is not dead stock. Dead can't be STOCKOUT/High by
 * construction (both need velocity > 0), but the guard is kept explicit so a
 * future risk-rule change can't silently pull dead stock into the queue.
 */
export function reorderFlag(risk: StockoutRisk, dead: boolean): boolean {
  return (risk === 'STOCKOUT' || risk === 'High') && !dead;
}

/**
 * trend = (avg_daily_sales_30d - avg_daily_sales_30_90d) / avg_daily_sales_30_90d.
 * Positive = accelerating, negative = slowing. Div-0 guard: null when the
 * 30-90d window is 0 (a brand-new or long-dormant SKU has no trend base).
 */
export function trendPct(d30: number, d30_90: number): number | null {
  if (!Number.isFinite(d30_90) || d30_90 <= 0) return null;
  return (d30 - d30_90) / d30_90;
}

// ── EOQ line quantities ──────────────────────────────────────────
//
// Buying ONE unit every few weeks wastes the fixed receiving/unpacking/binning
// labour that every order line costs regardless of quantity. The classic
// economic-order-quantity (Wilson) formula balances that fixed handling cost K
// against the annual holding cost h of carrying a bigger batch, giving the
// batch size that minimises total cost:  EOQ = sqrt(2 * D * K / h). We use the
// EOQ only to RAISE a line that the coverage math already wants (never to lower
// one and never to conjure a buy from nothing), capped so a cheap-slow SKU
// can't be pushed to years of cover.

/**
 * Annual demand D (units/year) for the EOQ + trips math. Forecast where the
 * SKU carries forward demand (sum of the 12-month forecast, month 0 pro-rated
 * so it isn't double-counting the elapsed part of the current month), else
 * trailing weighted velocity x 365. 0 when neither exists - the caller then
 * skips the escalation entirely (no demand, no batch to size).
 */
export function annualDemandUnits(velocity: number, forward: ForwardInput | null): number {
  if (forward) {
    const frac = Math.min(1, Math.max(0, forward.month0_fraction));
    let d = 0;
    for (let m = 0; m < forward.forecast.length; m++) {
      d += Math.max(0, forward.forecast[m] ?? 0) * (m === 0 ? frac : 1);
    }
    if (d > 0) return d;
  }
  return Number.isFinite(velocity) && velocity > 0 ? velocity * 365 : 0;
}

// ── Demand censoring quick fix ───────────────────────────────────
//
// A truly-out period suppresses observed sales (you can't sell what you don't
// have), so a forecast trained on those censored zeros under-reads demand on
// the very best sellers, and their
// EOQ/base buys are starved. Quick fix: for a TRULY_OUT-and-selling SKU, take
// the MAX of the forward-based demand figure and the trailing-velocity-based
// figure, so the censored forward can't drag the buy below what trailing sales
// already prove. NOT applied to MARKETPLACE_ONLY (their sales flow uncensored
// through marketplace stock) and NOT to in-stock SKUs (not censored). Bounded:
// both figures come from data already in hand, no new channels.

/**
 * The demand basis used for suggested buys + EOQ, with the censoring correction.
 * `forwardFigure` is the forecast-derived figure the caller would otherwise use
 * (units over the buy window, or annual demand); `trailingFigure` is the same
 * measure from trailing velocity. When `applyCorrection` (the SKU is TRULY_OUT
 * and selling), the result is max(forward, trailing) and `uncensored` is true
 * IFF the trailing figure strictly won (so the caller can attach the reason
 * only when it actually changed the number). Otherwise the forward figure is
 * returned untouched.
 */
export function resolveDemandBasis(args: {
  forwardFigure: number;
  trailingFigure: number;
  applyCorrection: boolean;
}): { figure: number; uncensored: boolean } {
  const { forwardFigure, trailingFigure, applyCorrection } = args;
  if (!applyCorrection) return { figure: forwardFigure, uncensored: false };
  if (trailingFigure > forwardFigure) return { figure: trailingFigure, uncensored: true };
  return { figure: forwardFigure, uncensored: false };
}

/**
 * The raw economic order quantity EOQ = sqrt(2 * D * K / h), where
 *   D = annual demand units,
 *   K = handling_cost_per_line (fixed cost per order line),
 *   h = holding_rate_annual * unit_cost (annual cost of holding one unit).
 * Returns 0 for any degenerate input (no demand, no handling cost, no holding
 * cost) - there is no meaningful batch to size, so EOQ never raises the line.
 * When unit_cost is unrecorded the holding term uses fallback_unit_cost; with
 * neither there is no holding cost to size against, so the result is 0.
 */
export function economicOrderQty(args: {
  annual_demand: number;
  handling_cost_per_line: number;
  holding_rate_annual: number;
  unit_cost: number | null;
  /** Unit cost assumed for an unpriced SKU (settings.eoq_fallback_unit_cost); absent = none. */
  fallback_unit_cost?: number;
}): number {
  const D = args.annual_demand;
  const K = args.handling_cost_per_line;
  const cost = args.unit_cost != null && args.unit_cost > 0 ? args.unit_cost : (args.fallback_unit_cost ?? 0);
  const h = args.holding_rate_annual * cost;
  if (!(D > 0) || !(K > 0) || !(h > 0)) return 0;
  const eoq = Math.sqrt((2 * D * K) / h);
  return Number.isFinite(eoq) ? eoq : 0;
}

/**
 * What a caller-defined performance label means to the buying maths:
 * 'priority' = buy first when stocked out, 'run_down' = never batch up.
 */
export type LabelRole = 'priority' | 'run_down';

/** Guard context for the EOQ top-up: label + explicit exclusions from the caller. */
export interface EoqContext {
  /** The SKU's performance label (caller-defined); null or absent when it has none. */
  label?: string | null;
  /**
   * The buyer flagged this SKU as one never to escalate (clearance /
   * discontinued / excluded via an override). When true the top-up is skipped
   * even if every other condition holds.
   */
  excluded?: boolean;
  /**
   * The caller's map from its own labels to roles. A label mapped to
   * 'run_down' blocks the top-up. No default: with no map, no label, or a
   * label the map does not name, nothing is blocked.
   */
  label_roles?: Record<string, LabelRole>;
  /**
   * A role the row already carries (for example from classifyPerformance).
   * Used when the label is absent or the map does not name it.
   */
  role?: LabelRole | null;
}

/**
 * The role of a row: its label through the caller's map when the map names
 * it, else the role the row carries, else none.
 */
export function resolveLabelRole(
  label: string | null | undefined,
  labelRoles: Readonly<Record<string, LabelRole>> | undefined,
  role?: LabelRole | null,
): LabelRole | null {
  if (label != null && labelRoles && Object.prototype.hasOwnProperty.call(labelRoles, label)) {
    return labelRoles[label] ?? null;
  }
  return role ?? null;
}

export interface EoqResult {
  /** The (possibly raised) final line quantity. */
  qty: number;
  /** True when the EOQ genuinely raised the line above baseQty. */
  applied: boolean;
  /** The annual demand D used (for the trips summary). */
  annual_demand: number;
}

/**
 * Apply the EOQ top-up to one line. Final = max(baseQty, min(round(EOQ),
 * coverCapQty)) but ONLY as a raise - if the cap would land below the base, the
 * base is kept (EOQ never lowers a line). coverCapQty = units covering
 * eoq_max_cover_days of forward demand; it binds the raw EOQ so a cheap-slow SKU
 * can't be pushed to years of stock.
 *
 * Guards (each returns the base untouched, applied:false):
 *   - EOQ disabled, no handling_cost_per_line, or no base suggestion (nothing
 *     to raise).
 *   - SKU is dead, carries a label whose role is 'run_down', or is excluded
 *     by the caller.
 *   - No unit cost and no eoq_fallback_unit_cost: no holding cost to size
 *     against.
 *   - No forward demand (annual demand 0): nothing to size a batch against.
 *   - The base already covers eoq_max_cover_days (raising would overshoot the
 *     cover cap): leave it.
 */
export function applyEoqLineQty(args: {
  baseQty: number;
  velocity: number;
  forward: ForwardInput | null;
  unit_cost: number | null;
  is_dead: boolean;
  settings: Pick<
    BuyerSettings,
    'eoq_enabled' | 'handling_cost_per_line' | 'eoq_fallback_unit_cost' | 'holding_rate_annual' | 'eoq_max_cover_days'
  >;
  ctx?: EoqContext;
  /**
   * Annual demand D to size the batch against, overriding the forward/velocity
   * default. The censoring quick fix passes an un-censored D here for
   * a TRULY_OUT seller so the batch isn't starved by suppressed sales.
   */
  annualDemandOverride?: number;
}): EoqResult {
  const { baseQty, velocity, forward, unit_cost, is_dead, settings, ctx } = args;
  const annualDemand =
    args.annualDemandOverride != null && args.annualDemandOverride > 0
      ? args.annualDemandOverride
      : annualDemandUnits(velocity, forward);
  const inert: EoqResult = { qty: baseQty, applied: false, annual_demand: annualDemand };

  if (!settings.eoq_enabled) return inert;
  if (!(baseQty > 0)) return inert;
  if (is_dead) return inert;
  if (ctx?.excluded) return inert;
  if (resolveLabelRole(ctx?.label, ctx?.label_roles, ctx?.role) === 'run_down') return inert;
  // No forward demand at all -> no batch to size (zero-demand guard).
  if (!(annualDemand > 0)) return inert;

  // An absent handling cost or an unpriced SKU with no fallback cost sizes to
  // 0 here, which leaves the line at its base.
  const eoq = economicOrderQty({
    annual_demand: annualDemand,
    handling_cost_per_line: settings.handling_cost_per_line ?? 0,
    holding_rate_annual: settings.holding_rate_annual,
    unit_cost,
    fallback_unit_cost: settings.eoq_fallback_unit_cost,
  });
  if (!(eoq > 0)) return inert;

  // Cover cap: units covering eoq_max_cover_days of forward demand. dailyDemand
  // is D / 365; the cap is dailyDemand x eoq_max_cover_days.
  const capDays = settings.eoq_max_cover_days;
  const coverCapQty = Math.floor((annualDemand / 365) * Math.max(0, capDays));

  // If the base already meets/exceeds the cover cap, a raise would push cover
  // past eoq_max_cover_days - leave the base alone.
  if (baseQty >= coverCapQty) return inert;

  const raised = Math.max(baseQty, Math.min(Math.round(eoq), coverCapQty));
  if (raised > baseQty) return { qty: raised, applied: true, annual_demand: annualDemand };
  return inert;
}

// ── Minimum order + pack quantities ─────────────────
//
// Supplier order constraints have TWO independent parts:
//   - a MINIMUM order quantity (a floor): never order fewer than N units;
//   - a PACK / carton MULTIPLE (the pack size): order in whole packs of N.
// A supplier whose orders go 5, 10, 20 has min 5 in multiples of 5; another
// might be min 100 in multiples of 100. They compose: a nonzero suggestion is
// first lifted to at least the min, THEN rounded up to a whole number of packs
// (suggestion 7, min 10, pack 5 -> 10; suggestion 12, min 10, pack 5 -> 15).
//
// Both apply AFTER the EOQ top-up (economics size the batch, then supplier
// reality lifts/rounds it), and a ZERO suggestion stays zero - neither a min
// nor a pack ever forces a buy the coverage math didn't want.
//
// Sources:
//   - min_order_qty: the caller's per-SKU override; null/0 = no floor. The
//     row carries no minimum, so the min has a single source.
//   - pack (pack_qty): the caller's per-SKU override first, else the row's
//     reorder_qty (the per-SKU reorder quantity, treated as a pack SIZE only;
//     null/0-tolerant).
//
// A row that carries ONLY a pack (no min) needs no separate floor:
// ceil(q/pack)*pack already lifts any nonzero q of 1..N up to N, which is the
// same floor-AND-multiple behaviour. The min matters only once it is larger
// than one pack.

/** The effective pack for a SKU and which source supplied it. */
export interface PackResolution {
  pack: number | null;
  /** 'override' = the caller's per-SKU override, 'input' = the row's reorder_qty. */
  source: 'override' | 'input' | null;
}

/**
 * Resolve the effective pack size: the buyer's per-SKU override (pack_qty > 0)
 * always wins; else the row's reorder_qty (> 0, rounded to whole
 * units); else null = no pack rule. 0/null/negative/NaN on either source
 * means "unset" - never a rule.
 */
export function resolveEffectivePack(
  overridePackQty: number | null | undefined,
  rowReorderQty: number | null | undefined,
): PackResolution {
  if (typeof overridePackQty === 'number' && Number.isFinite(overridePackQty) && overridePackQty > 0) {
    const p = Math.round(overridePackQty);
    if (p > 0) return { pack: p, source: 'override' };
  }
  if (typeof rowReorderQty === 'number' && Number.isFinite(rowReorderQty) && rowReorderQty > 0) {
    const p = Math.round(rowReorderQty);
    if (p > 0) return { pack: p, source: 'input' };
  }
  return { pack: null, source: null };
}

/**
 * Resolve the effective minimum order quantity (floor): the buyer's per-SKU
 * override (min_order_qty > 0), rounded to whole units; else null = no floor.
 * The row carries no minimum (its reorder_qty is a pack SIZE, not a
 * floor), so the min has a single source. 0/null/negative/NaN = "unset".
 */
export function resolveEffectiveMin(overrideMinQty: number | null | undefined): number | null {
  if (typeof overrideMinQty === 'number' && Number.isFinite(overrideMinQty) && overrideMinQty > 0) {
    const m = Math.round(overrideMinQty);
    if (m > 0) return m;
  }
  return null;
}

export interface PackRoundResult {
  /** The (possibly pack-rounded) final line quantity. */
  qty: number;
  /** True when pack rounding genuinely changed the quantity. */
  applied: boolean;
  /** True when the pack push landed past the cover cap (supplier still wins). */
  over_cap: boolean;
}

/**
 * Round one line up to a whole number of packs: ceil(baseQty / pack) * pack.
 * One formula covers both the floor case (71 -> 100 with a pack of 100) and
 * the multiple case (130 -> 200). Guards: no pack rule or a zero base
 * suggestion returns the base untouched - a pack size never conjures a buy.
 * coverCapQty is the EOQ cover cap in units (eoq_max_cover_days of demand;
 * null when demand is unknown): when the pack push lands PAST it, supplier
 * reality wins (the rounded quantity stands) but over_cap flags the overshoot
 * so the buyer sees the pack forced more cover than policy wanted.
 */
export function applyPackRounding(args: {
  baseQty: number;
  pack: number | null;
  coverCapQty: number | null;
}): PackRoundResult {
  const { baseQty, pack, coverCapQty } = args;
  if (pack == null || !(pack > 0) || !(baseQty > 0)) {
    return { qty: baseQty, applied: false, over_cap: false };
  }
  const rounded = Math.ceil(baseQty / pack) * pack;
  const applied = rounded !== baseQty;
  const overCap = applied && coverCapQty != null && coverCapQty > 0 && rounded > coverCapQty;
  return { qty: rounded, applied, over_cap: overCap };
}

export interface OrderConstraintResult {
  /** The final line quantity after the min floor + pack rounding. */
  qty: number;
  /** The line quantity after the min floor but BEFORE pack rounding (pre_pack_qty). */
  pre_pack_qty: number;
  /** True when the minimum floor lifted the quantity. */
  min_applied: boolean;
  /** True when pack rounding changed the (already min-lifted) quantity. */
  pack_applied: boolean;
  /** True when the final push landed past the cover cap (supplier still wins). */
  over_cap: boolean;
}

/**
 * Apply the two supplier order constraints in order: first lift a
 * nonzero suggestion to at least the minimum order quantity (the floor), THEN
 * round up to a whole number of packs (the multiple). They compose - a min of
 * 10 with a pack of 5 takes 7 -> 10 (min only, already a whole pack) and 12 ->
 * 15 (min doesn't bind, pack rounds). A ZERO base stays zero: neither a min nor
 * a pack ever conjures a buy the coverage math didn't want.
 *
 * pre_pack_qty is the post-min, pre-pack figure so a reader can show the pack
 * lift ("10 -> 15 (pack of 5)") against the already-floored quantity. over_cap
 * fires on the FINAL quantity (min or pack driven) landing past the EOQ cover
 * cap - supplier reality wins (the quantity stands) but the overshoot is flagged.
 */
export function applyOrderConstraints(args: {
  baseQty: number;
  minQty: number | null;
  pack: number | null;
  coverCapQty: number | null;
}): OrderConstraintResult {
  const { baseQty, minQty, pack, coverCapQty } = args;
  // A zero (or negative) base is never lifted - no constraint conjures a buy.
  if (!(baseQty > 0)) {
    return { qty: baseQty, pre_pack_qty: baseQty, min_applied: false, pack_applied: false, over_cap: false };
  }
  // 1. Minimum order quantity (floor).
  const floored = minQty != null && minQty > 0 ? Math.max(baseQty, minQty) : baseQty;
  const minApplied = floored > baseQty;
  // 2. Pack / multiple rounding on the floored figure.
  const packed = applyPackRounding({ baseQty: floored, pack, coverCapQty });
  const finalQty = packed.qty;
  // The cover cap flags an overshoot from EITHER constraint (min or pack).
  const overCap = coverCapQty != null && coverCapQty > 0 && finalQty > coverCapQty && (minApplied || packed.applied);
  return {
    qty: finalQty,
    pre_pack_qty: floored,
    min_applied: minApplied,
    pack_applied: packed.applied,
    over_cap: overCap,
  };
}

// ── One-shot derivation for a SKU ────────────────────────────────────────

/**
 * Derive the full buyer view of one SKU from its stats + the buyer settings +
 * the incoming units due inside ~2 months + (optionally) the SKU's forward
 * forecast (the caller computes both inputs so this stays pure). This is the
 * ONLY place the primitive formulas are assembled; every caller consumes
 * this.
 *
 * Basis selection: with settings.risk_basis 'forward_auto' and a
 * forecast that carries demand in the horizon, risk + suggested buy run on
 * FORWARD cover / forecast demand (seasonality-aware); otherwise they run on
 * trailing velocity. coverage_days always reports the
 * trailing figure; forward_coverage_days the forward one; `basis` says which
 * one drove the judgement.
 */
export function deriveSkuMetrics(
  stats: SkuStats,
  settings: BuyerSettings,
  incomingNext2m: number,
  forward?: ForwardInput | null,
  eoqCtx?: EoqContext,
  /**
   * A fallback marketplace stock figure the caller may pass, used only when
   * the row carries neither marketplace_soh nor is_saleable. null when
   * unknown - resolveSaleability then falls back to own-stock-only semantics.
   */
  fallbackMarketplaceSoh?: number | null,
  /**
   * The caller's per-SKU pack_qty override; null/absent = no override. Beats
   * the row's reorder_qty in resolveEffectivePack; the row value rides in on
   * stats.reorder_qty.
   */
  packQtyOverride?: number | null,
  /**
   * The caller's per-SKU min_order_qty override: the minimum order quantity
   * floor. null/absent = no floor. Applied before pack rounding;
   * single-sourced (the row carries no minimum).
   */
  minOrderQtyOverride?: number | null,
): DerivedSkuMetrics {
  const velocity = weightedVelocity(stats, settings.velocity_weights);
  const coverage = coverageDays(stats.qty, velocity);
  const target = resolveCoverageTarget(settings, stats.brand, stats.profitability_level, stats.class_1);
  const lead = resolveLeadTime(settings, stats.brand, stats.class_1);

  // Only trust the forecast for a SKU that has genuinely sold at some point
  // (recent windows OR all-time). A flat forecast on a never-sold SKU is noise,
  // not demand - without this gate it manufactures STOCKOUTs and phantom buys.
  const hasHistory = velocity > 0 || (stats.avg_daily_sales_all_time ?? 0) > 0;

  const fwdCoverage = forward ? forwardCoverageDays(stats.qty, forward) : null;
  const useForward = settings.risk_basis === 'forward_auto' && forward != null && fwdCoverage != null && hasHistory;
  const basis: 'forward' | 'trailing' = useForward ? 'forward' : 'trailing';

  // Forward basis treats "selling" as having demand in the current month, so
  // a stocked-out seasonal SKU whose trailing velocity already collapsed
  // still screams STOCKOUT ahead of the season.
  const fwdDemand30 = forward ? forecastUnitsWindow(forward, 30) : 0;
  const selling = velocity > 0 || (useForward && fwdDemand30 > 0);

  // Three-state saleability: own-stock 0 is not the same as unsaleable.
  // marketplace/dropship stock may still be selling the SKU.
  const saleability = resolveSaleability({
    own_qty: stats.qty,
    marketplace_soh: stats.marketplace_soh,
    is_saleable: stats.is_saleable,
    fallback_marketplace_soh: fallbackMarketplaceSoh,
  });
  // A TRULY_OUT-and-selling SKU is a real stockout; MARKETPLACE_ONLY-and-selling
  // is fulfilled from marketplace stock, so it gets its own tier and must
  // NOT count as STOCKOUT.
  const trulyOutSelling = saleability.state === 'TRULY_OUT' && selling;
  const mpOnlySelling = saleability.state === 'MARKETPLACE_ONLY' && selling;

  // Demand-censoring quick fix: a truly-out period suppresses observed
  // sales, so the forecast under-reads demand on the best sellers. For a
  // TRULY_OUT-and-selling SKU, take the max of the forward and trailing demand
  // figures. Not for MARKETPLACE_ONLY (uncensored sales) nor in-stock SKUs.
  const applyCensorFix = trulyOutSelling;

  // The demand window for the suggested buy: forecast units over
  // (target + lead) days on the forward basis, velocity * days on trailing.
  const windowDays = target + lead;
  const forwardWant = useForward ? forecastUnitsWindow(forward, windowDays) : velocity * windowDays;
  const trailingWant = velocity * windowDays;
  const wantResolved = resolveDemandBasis({
    forwardFigure: forwardWant,
    trailingFigure: trailingWant,
    applyCorrection: applyCensorFix,
  });
  const wantUnits = wantResolved.figure;

  const effectiveCoverage = useForward ? fwdCoverage : coverage;
  let risk: StockoutRisk;
  if (stats.qty <= 0 && selling && saleability.state === 'TRULY_OUT') risk = 'STOCKOUT';
  else if (effectiveCoverage != null && effectiveCoverage < lead) risk = 'High';
  else if (effectiveCoverage != null && effectiveCoverage < target) risk = 'Medium';
  else risk = 'Low';

  // Dead = stock on hand with neither trailing sales NOR forecast demand.
  const dead = isDead(stats.qty, velocity) && !(useForward && fwdDemand30 > 0);

  const baseBuy =
    target + lead <= 0 || !(wantUnits > 0)
      ? 0
      : Math.max(0, Math.round(wantUnits - stats.qty - incomingNext2m));

  // EOQ line-quantity top-up: raise a coverage-fill line to the
  // economic batch when the fixed handling labour makes a bigger buy cheaper.
  // Runs on the FORWARD forecast (falling back to velocity x 365) so the batch
  // is sized against real forward demand; guarded so dead/labelled/excluded/
  // zero-demand SKUs never escalate. Only ever raises, never lowers.
  //
  // Censoring quick fix: for a TRULY_OUT-and-selling SKU the EOQ's
  // annual demand D is also un-censored to max(forward D, trailing velocity x
  // 365), so a batch sized against censored zeros isn't starved.
  const forwardAnnual = annualDemandUnits(velocity, forward ?? null);
  const annualResolved = resolveDemandBasis({
    forwardFigure: forwardAnnual,
    trailingFigure: Number.isFinite(velocity) && velocity > 0 ? velocity * 365 : 0,
    applyCorrection: applyCensorFix,
  });
  const eoq = applyEoqLineQty({
    baseQty: baseBuy,
    velocity,
    forward: forward ?? null,
    unit_cost: stats.unit_cost,
    is_dead: dead,
    settings,
    ctx: eoqCtx,
    annualDemandOverride: annualResolved.figure,
  });

  // Minimum order + pack rounding, applied AFTER the EOQ
  // top-up: economics size the batch, then supplier reality lifts it to the
  // minimum order quantity floor and rounds it to whole packs. Zero suggestion
  // stays zero. The cover cap (the same eoq_max_cover_days figure that binds
  // the EOQ) only FLAGS an overshoot - supplier constraints win.
  // Buy rules: slow-seller min/max, new-SKU trial cap, max cover cap.
  const seasonalClass = (settings.seasonal_classes ?? []).some(
    (s) => s.toLowerCase() === stats.class_1.toLowerCase(),
  );
  const coverDays = Math.max(0, settings.max_cover_days);
  const forwardCover = useForward ? forecastUnitsWindow(forward, coverDays) : velocity * coverDays;
  const coverDemand = resolveDemandBasis({ forwardFigure: forwardCover, trailingFigure: velocity * coverDays, applyCorrection: applyCensorFix });
  const monthlyDemand = Math.max(useForward ? forecastUnitsWindow(forward, 90) / 3 : 0, velocity * 30);
  const ruleInput = (qty: number, coverUnits: number) => ({
    qty, stats, incoming_next_2m: incomingNext2m, monthly_demand: monthlyDemand, cover_demand_units: coverUnits,
    selling, has_history: hasHistory, seasonal_class: seasonalClass, settings,
  });
  const rules = applyBuyRules(ruleInput(eoq.qty, coverDemand.figure));
  const packRes = resolveEffectivePack(packQtyOverride, stats.reorder_qty);
  const minQty = resolveEffectiveMin(minOrderQtyOverride);
  const capDays = settings.max_cover_days > 0 ? Math.min(settings.eoq_max_cover_days, settings.max_cover_days) : settings.eoq_max_cover_days;
  const coverCapUnits = (annual: number): number | null =>
    annual > 0 ? Math.floor((annual / 365) * Math.max(0, capDays)) : null;
  const constrained = applyOrderConstraints({
    baseQty: rules.qty,
    minQty,
    pack: packRes.pack,
    coverCapQty: coverCapUnits(annualResolved.figure),
  });
  const buy = constrained.qty;

  // DEMAND_UNCENSORED fires only when the trailing figure won AND changed the
  // outcome (the base or EOQ line differs from what the censored forward gave).
  const demandUncensored =
    applyCensorFix &&
    (wantResolved.uncensored || annualResolved.uncensored) &&
    // "changed the outcome": recompute what the buy would have been on the
    // pure forward figures (pack-rounded the same way, so a pack that lands
    // both figures on the same multiple doesn't claim a censoring change)
    // and compare.
    (() => {
      const forwardBase =
        target + lead <= 0 || !(forwardWant > 0)
          ? 0
          : Math.max(0, Math.round(forwardWant - stats.qty - incomingNext2m));
      const forwardEoq = applyEoqLineQty({
        baseQty: forwardBase,
        velocity,
        forward: forward ?? null,
        unit_cost: stats.unit_cost,
        is_dead: dead,
        settings,
        ctx: eoqCtx,
        annualDemandOverride: forwardAnnual,
      });
      const forwardFinal = applyOrderConstraints({
        baseQty: applyBuyRules(ruleInput(forwardEoq.qty, forwardCover)).qty,
        minQty,
        pack: packRes.pack,
        coverCapQty: coverCapUnits(forwardAnnual),
      }).qty;
      return forwardFinal !== buy;
    })();

  // A seasonal/prebook class (seasonalClass, above) is bought outside the
  // reorder queue, so it never joins it.
  // Forecast demand but no sales history: the buy was suppressed by hasHistory.
  const forecastOnly = !hasHistory && forward != null && forecastUnitsWindow(forward, 30) > 0;

  return {
    sku: stats.sku,
    brand: stats.brand,
    weighted_velocity: velocity,
    coverage_days: coverage,
    forward_coverage_days: fwdCoverage,
    basis,
    coverage_target_days: target,
    coverage_gap_days: coverageGap(target, effectiveCoverage),
    lead_time_days: lead,
    stockout_risk: risk,
    saleability: saleability.state,
    marketplace_soh: saleability.marketplace_soh,
    mp_only_selling: mpOnlySelling,
    is_dead: dead,
    reorder: reorderFlag(risk, dead) && !seasonalClass,
    trend_pct: trendPct(stats.avg_daily_sales_30d, stats.avg_daily_sales_30_90d),
    suggested_buy_qty: buy,
    eoq_base_qty: baseBuy,
    eoq_qty: eoq.qty,
    eoq_applied: eoq.applied,
    eoq_annual_demand: eoq.annual_demand,
    min_order_qty: minQty,
    pack_qty: packRes.pack,
    pack_source: packRes.source,
    min_applied: constrained.min_applied,
    pre_pack_qty: constrained.pre_pack_qty,
    pack_applied: constrained.pack_applied,
    pack_over_cap: constrained.over_cap,
    demand_uncensored: demandUncensored,
    incoming_next_2m: incomingNext2m,
    seasonal_class: seasonalClass,
    forecast_only: forecastOnly,
    cover_demand_units: coverDemand.figure,
    monthly_demand: monthlyDemand,
    rule_qty: rules.qty,
    slow_seller: rules.slow_seller,
    new_sku: rules.new_sku,
    trial_capped: rules.trial_capped,
    cover_capped: rules.cover_capped,
  };
}

/**
 * Structured reasons for one SKU's derived judgement - built from the SAME
 * derived numbers deriveSkuMetrics computed, so the explanation can never
 * drift from the math. Ordered most-important first (the risk driver leads).
 */
export function skuReasons(
  d: DerivedSkuMetrics,
  stats: Pick<SkuStats, 'age_of_oldest_item_days' | 'profitability_level' | 'qty'>,
  settings: BuyerSettings,
): Reason[] {
  const out: Reason[] = [];
  // The cover figure that actually drove the risk tier (forward when the
  // forecast basis was in force, trailing otherwise).
  const effective = d.basis === 'forward' ? d.forward_coverage_days : d.coverage_days;
  const cover = effective != null ? Math.round(effective) : null;
  const coverWord = d.basis === 'forward' ? 'forward cover' : 'cover';

  if (d.stockout_risk === 'STOCKOUT') {
    out.push(
      d.weighted_velocity > 0
        ? reason(
            'STOCKED_OUT_SELLING',
            `selling ${d.weighted_velocity.toFixed(2)}/day with zero stock on hand`,
            d.weighted_velocity,
          )
        : reason('STOCKED_OUT_SELLING', 'zero stock with forecast demand this month'),
    );
  } else if (d.stockout_risk === 'High' && cover != null) {
    out.push(reason('BELOW_LEAD_TIME_COVER', `${coverWord} ${cover}d < lead time ${d.lead_time_days}d`, cover));
  } else if (d.stockout_risk === 'Medium' && cover != null) {
    out.push(
      reason('BELOW_TARGET_COVER', `${coverWord} ${cover}d < target ${Math.round(d.coverage_target_days)}d`, cover),
    );
  }

  // Marketplace-only fulfilment: own stock is 0 but marketplace /
  // dropship stock is still selling - informational, NOT a stockout urgency.
  if (d.mp_only_selling) {
    out.push(
      reason(
        'MP_FULFILLED',
        d.marketplace_soh != null
          ? `own stock 0 but ${Math.round(d.marketplace_soh)} marketplace units still selling - not a true stockout`
          : 'own stock 0 but marketplace/dropship stock still selling - not a true stockout',
        d.marketplace_soh ?? undefined,
      ),
    );
  }

  // Why a risky-looking SKU is NOT on the reorder queue.
  if (d.seasonal_class) {
    out.push(reason('SEASONAL_CLASS', 'seasonal/prebook class - bought outside the reorder queue'));
  }
  if (d.forecast_only) {
    out.push(reason('FORECAST_ONLY_NO_HISTORY', 'forecast shows demand but the SKU has never sold - buy suppressed'));
  }

  // Demand-censoring correction: trailing sales beat the forecast
  // (which was censored by the stockout) and changed the buy.
  if (d.demand_uncensored) {
    out.push(
      reason(
        'DEMAND_UNCENSORED',
        'forecast under-read demand (censored by the stockout); trailing sales raised the buy',
      ),
    );
  }

  // EOQ top-up: the coverage math wanted eoq_base_qty; raised to the
  // economic batch so the fixed receiving labour isn't paid on a tiny line.
  if (d.eoq_applied) {
    out.push(
      reason(
        'EOQ_TOPUP',
        `raised ${d.eoq_base_qty} -> ${d.eoq_qty} to the economic order quantity (saves repeat receiving/binning labour)`,
        d.eoq_qty,
      ),
    );
  }

  // Buy rules: say which rule changed the line and from what.
  if (d.slow_seller && d.rule_qty < d.eoq_qty) {
    out.push(reason('SLOW_SELLER_MINMAX', `slow seller (${d.monthly_demand.toFixed(1)}/month): keep ${Math.round(settings.slow_seller_stock_target)} on hand, reorder on sale`, d.rule_qty));
  }
  if (d.trial_capped) {
    out.push(reason('NEW_SKU_TRIAL', `new product: ${d.eoq_qty} -> ${d.rule_qty} trial buy until it proves itself`, d.rule_qty));
  }
  if (d.cover_capped) {
    out.push(reason('COVER_CAPPED', `${d.eoq_qty} -> ${d.rule_qty}: capped at ${Math.round(settings.max_cover_days)}d of demand`, d.rule_qty));
  }

  // Minimum order quantity: the supplier floor lifted the line up to
  // the minimum. Applied after the EOQ and before pack rounding; only when it
  // changed the quantity. eoq_qty is the pre-min figure, pre_pack_qty the
  // post-min one, so the lift reads "7 -> 10 (min order 10)".
  if (d.min_applied && d.min_order_qty != null) {
    out.push(
      reason(
        'MIN_ORDER_APPLIED',
        `${d.rule_qty} -> ${d.pre_pack_qty} (min order ${d.min_order_qty}, buyer override)`,
        d.min_order_qty,
      ),
    );
  }

  // Pack rounding: the supplier pack size lifted the line to a whole
  // number of packs. Applied after the min floor, only when it changed the
  // quantity. pre_pack_qty is the post-min figure the pack rounded from.
  if (d.pack_applied && d.pack_qty != null) {
    const src = d.pack_source === 'override' ? 'buyer override' : 'reorder qty';
    out.push(
      reason(
        'PACK_ROUNDED',
        `${d.pre_pack_qty} -> ${d.suggested_buy_qty} (pack of ${d.pack_qty}, ${src})`,
        d.pack_qty,
      ),
    );
  }
  if (d.pack_over_cap && d.pack_qty != null) {
    out.push(
      reason(
        'PACK_OVER_CAP',
        `the supplier minimum/pack pushes the buy past the ${Math.round(settings.max_cover_days > 0 ? Math.min(settings.eoq_max_cover_days, settings.max_cover_days) : settings.eoq_max_cover_days)}d cover cap - supplier constraint wins`,
        d.pack_qty,
      ),
    );
  }

  // Seasonality callouts: forward cover much thinner than trailing means the
  // forecast sees demand ramping ahead of recent history (and vice versa).
  if (d.basis === 'forward' && d.forward_coverage_days != null && d.coverage_days != null && d.coverage_days > 0) {
    if (d.forward_coverage_days < d.coverage_days * settings.season_peak_ratio) {
      out.push(
        reason(
          'SEASON_PEAK_AHEAD',
          `forecast demand ahead cuts cover to ${Math.round(d.forward_coverage_days)}d vs ${Math.round(d.coverage_days)}d on trailing sales`,
          d.forward_coverage_days,
        ),
      );
    } else if (d.forward_coverage_days > d.coverage_days * settings.season_slowdown_ratio) {
      out.push(
        reason(
          'SEASON_SLOWDOWN_AHEAD',
          `forecast demand ahead stretches cover to ${Math.round(d.forward_coverage_days)}d vs ${Math.round(d.coverage_days)}d on trailing sales`,
          d.forward_coverage_days,
        ),
      );
    }
  }

  if (d.is_dead) {
    // The span is the velocity windows the blend actually reads.
    const span = velocityLookbackDays(settings.velocity_weights);
    out.push(reason('DEAD_STOCK', `${Math.round(stats.qty)} units on hand with no sales across ${span}d`, stats.qty));
  }

  if (d.trend_pct != null && Math.abs(d.trend_pct) >= settings.trend_reason_threshold) {
    const pct = Math.round(d.trend_pct * 100);
    out.push(
      d.trend_pct > 0
        ? reason('TREND_ACCEL', `30d velocity +${pct}% vs 30-90d base`, d.trend_pct)
        : reason('TREND_DECEL', `30d velocity ${pct}% vs 30-90d base`, d.trend_pct),
    );
  }

  const age = stats.age_of_oldest_item_days;
  // The codes name the two buckets; settings.aged_days sets where they start.
  const [agedFirst, agedSecond] = settings.aged_days;
  if (age != null && age > agedSecond) out.push(reason('AGED_SECOND', `oldest item ${Math.round(age)}d old`, age));
  else if (age != null && age > agedFirst) out.push(reason('AGED_FIRST', `oldest item ${Math.round(age)}d old`, age));

  const adj = profitabilityAdjust(settings.profitability_coverage_adjust, stats.profitability_level);
  if (adj < 0) {
    out.push(
      reason(
        'PROFITABILITY_TIER_SUPPRESSED',
        `profitability level ${stats.profitability_level} cuts coverage target ${Math.round(adj * -100)}% to ${Math.round(d.coverage_target_days)}d`,
        d.coverage_target_days,
      ),
    );
  }

  if (d.reorder && d.suggested_buy_qty === 0 && d.incoming_next_2m > 0) {
    out.push(
      reason(
        'INBOUND_COVERS_GAP',
        `${Math.round(d.incoming_next_2m)} inbound units within 2 months cover the gap`,
        d.incoming_next_2m,
      ),
    );
  }

  return out;
}

/** The most common label in a vote map (ties broken alphabetically); null when empty. */
function mostCommonLabel(votes: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = -1;
  for (const [label, n] of votes) {
    if (n > bestN || (n === bestN && best !== null && label < best)) {
      best = label;
      bestN = n;
    }
  }
  return best;
}

/**
 * Collapse brand labels that differ only in case ("Brand B" / "BRAND B") onto
 * their most common spelling (ties broken alphabetically). Brand-keyed state
 * is matched by brandKey, so two case variants must be one group or they
 * would each claim the same budget. Rows with an empty brand are left alone;
 * the same array is returned when no label differs. Pure: run it on the rows
 * before grouping by brand. Any other repair of brand data is the caller's.
 */
export function collapseBrandCase<T extends { brand: string }>(rows: T[]): T[] {
  const spellings = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.brand) continue;
    const k = brandKey(r.brand);
    const m = spellings.get(k) ?? new Map<string, number>();
    m.set(r.brand, (m.get(r.brand) ?? 0) + 1);
    spellings.set(k, m);
  }
  const canonical = new Map<string, string>();
  for (const [k, m] of spellings) {
    const best = m.size > 1 ? mostCommonLabel(m) : null;
    if (best) canonical.set(k, best);
  }
  if (canonical.size === 0) return rows;
  return rows.map((r) => {
    const label = r.brand ? canonical.get(brandKey(r.brand)) : undefined;
    return label !== undefined && label !== r.brand ? { ...r, brand: label } : r;
  });
}

/** Sort weight for risk tiers - STOCKOUT most urgent. */
export const RISK_ORDER: Record<StockoutRisk, number> = {
  STOCKOUT: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

/**
 * Canonical reorder-queue ordering: risk tier first (STOCKOUT → High → ...),
 * then thinnest coverage first (null coverage sorts last within a tier),
 * then biggest suggested buy first, then SKU for stability.
 */
export function compareByRisk(
  a: Pick<DerivedSkuMetrics, 'stockout_risk' | 'coverage_days' | 'suggested_buy_qty' | 'sku'>,
  b: Pick<DerivedSkuMetrics, 'stockout_risk' | 'coverage_days' | 'suggested_buy_qty' | 'sku'>,
): number {
  const tier = RISK_ORDER[a.stockout_risk] - RISK_ORDER[b.stockout_risk];
  if (tier !== 0) return tier;
  const ca = a.coverage_days ?? Number.POSITIVE_INFINITY;
  const cb = b.coverage_days ?? Number.POSITIVE_INFINITY;
  if (ca !== cb) return ca - cb;
  if (a.suggested_buy_qty !== b.suggested_buy_qty) return b.suggested_buy_qty - a.suggested_buy_qty;
  return a.sku.localeCompare(b.sku);
}
