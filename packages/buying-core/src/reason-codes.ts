/**
 * buying-core - structured reason codes.
 *
 * Every derived judgement the workbench makes (risk tier, action signal,
 * exception) carries a machine-readable WHY: a list of Reason objects built
 * from the same numbers that drove the judgement. The dashboard renders them
 * as tooltips; agent tools return them verbatim so an agent can explain a
 * recommendation without re-deriving the math. Codes are a closed enum -
 * add here, never inline string literals at call sites.
 */

export type ReasonCode =
  // SKU / queue-row reasons
  | 'STOCKED_OUT_SELLING' // qty <= 0 while velocity > 0
  | 'BELOW_LEAD_TIME_COVER' // coverage_days < lead_time_days
  | 'BELOW_TARGET_COVER' // coverage_days < coverage_target_days
  | 'TREND_ACCEL' // 30d velocity well above 30-90d base
  | 'TREND_DECEL' // 30d velocity well below 30-90d base
  | 'DEAD_STOCK' // stock on hand, zero blended velocity
  | 'AGED_90' // oldest item 90-180 days old
  | 'AGED_180' // oldest item > 180 days old
  | 'OVERCOVER' // cover far past the overcover threshold - capital parked in excess stock (markdown candidate; NOT a cover shortfall like BELOW_TARGET_COVER)
  | 'PROFITABILITY_TIER_SUPPRESSED' // profitability curve cut the coverage target
  | 'INBOUND_COVERS_GAP' // suggested buy 0 because inbound stock covers it
  | 'SEASON_PEAK_AHEAD' // forecast demand ahead runs well above trailing velocity
  | 'SEASON_SLOWDOWN_AHEAD' // forecast demand ahead runs well below trailing velocity
  | 'FORECAST_ONLY_NO_HISTORY' // forecast shows demand but the SKU has never sold - buy suppressed
  | 'SEASONAL_CLASS' // seasonal/prebook class (seasonal lines) - bought via the seasonal panel, not the queue
  | 'EOQ_TOPUP' // line raised from its coverage-fill base to the economic order quantity
  // Saleability reasons - own-stock 0 is not the same as unsaleable
  | 'MP_FULFILLED' // own stock 0 but marketplace/dropship stock is still selling - not a true stockout
  | 'DEMAND_UNCENSORED' // trailing velocity beat the (censored) forward figure for a truly-out seller
  // Pack / minimum order quantities
  | 'MIN_ORDER_APPLIED' // suggestion lifted up to the supplier minimum order quantity floor
  | 'PACK_ROUNDED' // line rounded up to a whole number of supplier packs ("71 -> 100 (pack of 100)")
  | 'PACK_OVER_CAP' // the pack push landed past the EOQ cover cap - supplier pack size wins, flagged
  // Buy rules (buy-rules.ts)
  | 'SLOW_SELLER_MINMAX' // under ~1 sale a month: keep a small fixed stock, reorder on sale
  | 'NEW_SKU_TRIAL' // new/re-launched product: line capped at a trial quantity
  | 'COVER_CAPPED' // line cut so stock + inbound + buy stays within max_cover_days of demand
  // Purchase-order reasons
  | 'SELL_THROUGH_STRONG' // >= 70% sold of received
  | 'SELL_THROUGH_LOW' // < 40% sold of received
  | 'MARGIN_PER_DOLLAR_LOW' // margin per $ landed < 0.2
  | 'STOCK_NEARLY_GONE' // in-stock at/below the reorder threshold
  | 'AGED_STOCK_SHARE_HIGH' // > 15% of in-stock aged past 90d
  | 'DEAD_STOCK_180' // units unsold past 180 days
  | 'STILL_INCOMING' // nothing received yet - no judgement possible
  | 'TOO_EARLY_TO_JUDGE' // stock landed under PO_JUDGE_MIN_DAYS ago - too new to grade
  | 'SUPPLIER_LATE' // ETA slipped materially vs the original
  // Buy-plan reasons
  | 'OTB_EXHAUSTED' // brand budget headroom used up - line skipped
  | 'UNCOSTED' // no unit cost recorded - cannot price the order
  // Ads / performance-label reasons
  | 'HERO_SKU' // Hero-labelled SKU that is stocked out - top buying priority
  | 'AD_WASTE' // ad spend running on a stocked-out / dead / villain SKU - waste
  | 'PERF_LABEL'; // the SKU's performance label (Heroes / Villains / Dead / …)

export interface Reason {
  code: ReasonCode;
  /** Human sentence with the actual numbers ("cover 9d < lead time 14d"). */
  detail: string;
  /** The primary numeric driver, when one exists (days, %, units). */
  value?: number;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

export const reason = (code: ReasonCode, detail: string, value?: number): Reason =>
  value === undefined ? { code, detail } : { code, detail, value: r1(value) };
