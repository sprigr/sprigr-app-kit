/**
 * buying-core - newsvendor seasonal buy (pure).
 *
 * The textbook model for one-shot seasonal buys: order at
 * the critical fractile of the season-demand distribution,
 *
 *   F(Q*) = Cu / (Cu + Co)
 *
 * with Cu = unit underage cost (margin lost per unit short) and Co = unit
 * overage cost (cost - salvage per unit left over). Demand over the season is
 * modelled Normal(mean, sigma * sqrt(months)) with the mean from the forward
 * forecast and sigma from the SKU's monthly-sales history. Every assumption
 * is echoed in the result so the caller can sanity-check it.
 */

export interface SeasonalBuyInput {
  sku: string;
  /** Selling price per unit (avg realized price, else RRP). */
  price: number;
  /** Landed cost per unit. */
  unit_cost: number;
  /** Fraction of cost recoverable on leftovers (clearance/salvage), [0, 1). */
  salvage_rate: number;
  /** Forecast unit demand for the season (sum of the season's forecast months). */
  season_demand_mean: number;
  /** Std-dev of MONTHLY demand (from history); scaled by sqrt(months). */
  monthly_sigma: number;
  season_months: number;
  /** Units already on hand + on order for the season. */
  already_committed: number;
}

export interface SeasonalBuyResult {
  sku: string;
  critical_fractile: number;
  z: number;
  season_demand_mean: number;
  season_sigma: number;
  /** The optimal season stock position Q*. */
  q_star: number;
  /** Q* net of stock already held/on order (never negative). */
  suggested_buy: number;
  underage_cost: number;
  overage_cost: number;
  assumptions: string;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, |err| < 1.2e-9).
 * Good far beyond what a buy quantity needs.
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return 0;
  // Coefficients and the 0.02425 tail break are Acklam's published values, not tuning.
  const a =[-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** One SKU's seasonal buy. Returns null when the economics are degenerate. */
export function seasonalBuy(input: SeasonalBuyInput): SeasonalBuyResult | null {
  const cu = input.price - input.unit_cost;
  const co = input.unit_cost * (1 - Math.min(0.99, Math.max(0, input.salvage_rate)));
  if (!(cu > 0) || !(co > 0) || !(input.season_demand_mean > 0)) return null;
  const fractile = cu / (cu + co);
  const z = normalQuantile(fractile);
  const sigma = Math.max(0, input.monthly_sigma) * Math.sqrt(Math.max(1, input.season_months));
  const qStar = Math.max(0, input.season_demand_mean + z * sigma);
  const buy = Math.max(0, Math.round(qStar - Math.max(0, input.already_committed)));
  return {
    sku: input.sku,
    critical_fractile: Math.round(fractile * 1000) / 1000,
    z: Math.round(z * 100) / 100,
    season_demand_mean: r2(input.season_demand_mean),
    season_sigma: r2(sigma),
    q_star: Math.round(qStar),
    suggested_buy: buy,
    underage_cost: r2(cu),
    overage_cost: r2(co),
    assumptions: `demand ~ Normal(${r2(input.season_demand_mean)}, ${r2(sigma)}) over ${input.season_months}mo; salvage ${Math.round(input.salvage_rate * 100)}% of cost`,
  };
}

/** Std-dev of a monthly units series (population); 0 for < 2 points. */
export function monthlySigma(unitsByMonth: number[]): number {
  const xs = unitsByMonth.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}
