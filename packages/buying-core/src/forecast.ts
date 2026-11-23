/**
 * buying-core - in-app demand forecast (pure).
 *
 * Demand forecasts computed from per-SKU monthly history. A seasonal-naive
 * repeater is the baseline every other method is measured against.
 * Everything is pure and clock-free: callers pass `nowMonth` (YYYY-MM);
 * the current (partial) month is never trained on or scored.
 *
 * Design:
 *  - A SkuSeries is a contiguous, gap-filled calendar series of CLOSED
 *    months. The caller's input may omit all-zero months, so gap-filling
 *    with zeros is essential - a missing month IS a zero-sales month for
 *    any SKU that has already had activity.
 *  - Seasonality is POOLED per class: per-SKU monthly data is far too
 *    sparse to fit 12 indices per SKU, while a class pools enough
 *    SKU-months to show a stable seasonal shape. Indices are damped toward
 *    1 by sample size so a thin class doesn't get a wild curve.
 *  - Forecasters implement one interface and are selected empirically per
 *    class by the backtest harness (backtest.ts) - a tournament, not
 *    a bet on one method. `seasonal_naive` (same month last year, repeated)
 *    is the baseline in backtests.
 */

// ── Month math (string YYYY-MM, clock-free) ──────────────────────────────

/** monthAdd('2026-01', -2) -> '2025-11'. */
export function monthAdd(month: string, delta: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}

/** Whole months from a to b (b - a); monthDiff('2026-01','2026-03') = 2. */
export function monthDiff(a: string, b: string): number {
  const ya = Number(a.slice(0, 4)) * 12 + Number(a.slice(5, 7));
  const yb = Number(b.slice(0, 4)) * 12 + Number(b.slice(5, 7));
  return yb - ya;
}

/** Calendar month index 0-11 of a YYYY-MM. */
export const calMonth = (month: string): number => Number(month.slice(5, 7)) - 1;

// ── Series building ──────────────────────────────────────────────────────

/** Minimal input row (matches MonthlyMetricRow's relevant fields). */
export interface MonthlyPoint {
  sku: string;
  month: string; // YYYY-MM
  units_sold: number;
}

export interface SkuSeries {
  sku: string;
  class_1: string;
  /** First month of the series (first recorded activity). */
  startMonth: string;
  /**
   * Contiguous closed-month units, oldest -> newest, gap-filled with 0.
   * Last entry is the last CLOSED month (the month before nowMonth).
   */
  units: number[];
}

/**
 * Build gap-filled closed-month series per SKU. Months at/after nowMonth are
 * dropped (current month is partial; future rows are forecast noise). A SKU
 * with no closed-month activity yields no series.
 */
export function buildSeries(
  rows: MonthlyPoint[],
  classBySku: Map<string, string>,
  nowMonth: string,
): SkuSeries[] {
  const bySku = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.month || r.month >= nowMonth) continue;
    const m = bySku.get(r.sku) ?? new Map<string, number>();
    m.set(r.month, (m.get(r.month) ?? 0) + (Number.isFinite(r.units_sold) ? r.units_sold : 0));
    bySku.set(r.sku, m);
  }
  const lastClosed = monthAdd(nowMonth, -1);
  const out: SkuSeries[] = [];
  for (const [sku, months] of bySku) {
    // Start at the first month with any recorded row: the SKU's first
    // activity in the caller's input.
    const keys = [...months.keys()].sort();
    const start = keys[0]!;
    const n = monthDiff(start, lastClosed) + 1;
    if (n <= 0) continue;
    const units: number[] = new Array(n);
    for (let i = 0; i < n; i++) units[i] = months.get(monthAdd(start, i)) ?? 0;
    out.push({
      sku,
      class_1: classBySku.get(sku) ?? '(unknown)',
      startMonth: start,
      units,
    });
  }
  return out.sort((a, b) => a.sku.localeCompare(b.sku));
}

// ── Pooled class seasonality ─────────────────────────────────────────────

/** 12 multiplicative indices (calendar Jan..Dec), mean 1, damped by sample size. */
export type SeasonalIndex = number[];

/**
 * Tuning for the seasonal index and the smoothing forecasters. Every field
 * is optional at the call site: pass a partial and the rest keep the
 * defaults in DEFAULT_FORECAST_PARAMS.
 */
export interface ForecastParams {
  /**
   * Seasonal-index damping K: an index estimated from n SKU-months is
   * shrunk toward 1 by n/(n+K). At 12 a calendar-month bucket needs 12
   * observations to keep half its raw swing; 0 turns damping off.
   * Default 12.
   */
  index_damping_k: number;
  /**
   * A seasonal index at or below this is treated as 1 when dividing it out,
   * so a near-zero index cannot blow a level up. Default 0.05.
   */
  index_floor: number;
  /** SBA demand-size smoothing. Default 0.15. */
  sba_alpha: number;
  /** SBA inter-demand-interval smoothing; also sets the (1 - beta/2) debias. Default 0.15. */
  sba_beta: number;
  /** TSB demand-size smoothing. Default 0.15. */
  tsb_alpha: number;
  /**
   * TSB occurrence-probability smoothing. Kept small so an off-season gap
   * does not drive the probability to zero. Default 0.05.
   */
  tsb_beta: number;
  /** Damped-trend level smoothing. Default 0.2. */
  damped_alpha: number;
  /** Damped-trend trend smoothing. Default 0.05. */
  damped_beta: number;
  /** Damped-trend damping factor phi; below 1 flattens the trend over the horizon. Default 0.9. */
  damped_phi: number;
  /** ADIDA smoothing of the quarterly totals. Default 0.2. */
  adida_alpha: number;
}

/**
 * Defaults for ForecastParams. The smoothing constants sit in the 0.05-0.3
 * range the intermittent-demand literature uses for short series.
 */
export const DEFAULT_FORECAST_PARAMS: ForecastParams = {
  index_damping_k: 12,
  index_floor: 0.05,
  sba_alpha: 0.15,
  sba_beta: 0.15,
  tsb_alpha: 0.15,
  tsb_beta: 0.05,
  damped_alpha: 0.2,
  damped_beta: 0.05,
  damped_phi: 0.9,
  adida_alpha: 0.2,
};

/** Merge caller params over the defaults; a missing or non-finite field keeps its default. */
function resolveParams(params?: Partial<ForecastParams>): ForecastParams {
  if (!params) return DEFAULT_FORECAST_PARAMS;
  const out: ForecastParams = { ...DEFAULT_FORECAST_PARAMS };
  for (const k of Object.keys(DEFAULT_FORECAST_PARAMS) as (keyof ForecastParams)[]) {
    const v = params[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Pooled seasonal indices per class. For each class and calendar
 * month: index = (mean units across that class's SKU-months landing on that
 * calendar month) / (class's overall mean). Damped toward 1 with weight
 * n/(n+K), K = params.index_damping_k, so classes with little data get a
 * nearly flat curve. Classes with zero total sales get a flat curve.
 */
export function classSeasonalIndices(
  series: SkuSeries[],
  params?: Partial<ForecastParams>,
): Map<string, SeasonalIndex> {
  const dampingK = resolveParams(params).index_damping_k;
  interface Acc {
    sum: number[];
    n: number[];
  }
  const byClass = new Map<string, Acc>();
  for (const s of series) {
    const acc = byClass.get(s.class_1) ?? { sum: new Array(12).fill(0), n: new Array(12).fill(0) };
    for (let i = 0; i < s.units.length; i++) {
      const cm = calMonth(monthAdd(s.startMonth, i));
      acc.sum[cm] += s.units[i]!;
      acc.n[cm] += 1;
    }
    byClass.set(s.class_1, acc);
  }
  const out = new Map<string, SeasonalIndex>();
  for (const [cls, acc] of byClass) {
    const totalSum = acc.sum.reduce((a, b) => a + b, 0);
    const totalN = acc.n.reduce((a, b) => a + b, 0);
    const overallMean = totalN > 0 ? totalSum / totalN : 0;
    const idx: number[] = new Array(12).fill(1);
    if (overallMean > 0) {
      for (let m = 0; m < 12; m++) {
        const n = acc.n[m]!;
        const monthMean = n > 0 ? acc.sum[m]! / n : overallMean;
        const raw = monthMean / overallMean;
        // n = 0 with K = 0 would be 0/0; an empty bucket carries no weight.
        const w = n > 0 ? n / (n + dampingK) : 0;
        idx[m] = 1 + w * (raw - 1);
      }
      // Renormalize to mean 1 so the index reshapes, never inflates, a level.
      const mean = idx.reduce((a, b) => a + b, 0) / 12;
      if (mean > 0) for (let m = 0; m < 12; m++) idx[m] = idx[m]! / mean;
    }
    out.set(cls, idx);
  }
  return out;
}

// ── Forecaster interface + baselines ─────────────────────────────────────

export interface ForecastContext {
  /** Class seasonal index (calendar Jan..Dec, mean 1). Flat [1..] when unknown. */
  seasonalIndex: SeasonalIndex;
  /** Calendar month (0-11) of the FIRST month being forecast. */
  firstTargetCalMonth: number;
}

export interface Forecaster {
  key: string;
  /**
   * Forecast `horizon` months from the end of `units` (closed months,
   * oldest -> newest, startCalMonth = calendar month of units[0]).
   * Returns non-negative unit forecasts, length `horizon`. `params` is
   * merged over DEFAULT_FORECAST_PARAMS; a method reads only its own fields.
   */
  forecast(
    units: number[],
    startCalMonth: number,
    horizon: number,
    ctx: ForecastContext,
    params?: Partial<ForecastParams>,
  ): number[];
}

export const FLAT_INDEX: SeasonalIndex = new Array(12).fill(1);

const nonNeg = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);

/** Mean of the last n entries (fewer when the series is shorter). */
function tailMean(units: number[], n: number): number {
  if (units.length === 0) return 0;
  const k = Math.min(n, units.length);
  let s = 0;
  for (let i = units.length - k; i < units.length; i++) s += units[i]!;
  return s / k;
}

/**
 * The baseline: same calendar month last year; falls back to the
 * trailing 3-month mean when the series is too short to look back 12.
 */
export const seasonalNaive: Forecaster = {
  key: 'seasonal_naive',
  forecast(units, _startCalMonth, horizon) {
    const out: number[] = new Array(horizon);
    for (let h = 0; h < horizon; h++) {
      const idx = units.length + h - 12;
      out[h] = idx >= 0 && idx < units.length ? nonNeg(units[idx]!) : nonNeg(tailMean(units, 3));
    }
    return out;
  },
};

/** Trailing 3-month mean, flat forward - the "recent run-rate" baseline. */
export const runRate3m: Forecaster = {
  key: 'run_rate_3m',
  forecast(units, _startCalMonth, horizon) {
    const level = nonNeg(tailMean(units, 3));
    return new Array(horizon).fill(level);
  },
};

/**
 * Deseasonalized run-rate reshaped by the class curve: level = mean of the
 * last 3 months divided by their seasonal indices (so a summer reading isn't
 * mistaken for a level shift), forecast = level * index[target month].
 */
export const runRateIndex: Forecaster = {
  key: 'run_rate_index',
  forecast(units, startCalMonth, horizon, ctx, params) {
    const idx = ctx.seasonalIndex;
    const floor = resolveParams(params).index_floor;
    const k = Math.min(3, units.length);
    let level = 0;
    if (k > 0) {
      let s = 0;
      for (let i = units.length - k; i < units.length; i++) {
        const cm = (startCalMonth + i) % 12;
        const si = idx[cm]! > floor ? idx[cm]! : 1;
        s += units[i]! / si;
      }
      level = s / k;
    }
    const out: number[] = new Array(horizon);
    for (let h = 0; h < horizon; h++) {
      out[h] = nonNeg(level * idx[(ctx.firstTargetCalMonth + h) % 12]!);
    }
    return out;
  },
};

/** Equal-weight combination of seasonal-naive and index-reshaped run-rate. */
export const blendNaiveIndex: Forecaster = {
  key: 'blend_naive_index',
  forecast(units, startCalMonth, horizon, ctx, params) {
    const a = seasonalNaive.forecast(units, startCalMonth, horizon, ctx, params);
    const b = runRateIndex.forecast(units, startCalMonth, horizon, ctx, params);
    return a.map((v, i) => (v + b[i]!) / 2);
  },
};

// ── Research-selected methods ─────────────────
//
// SBA (Syntetos-Boylan Approximation) and TSB (Teunter-Syntetos-Babai) are
// the literature's intermittent-demand standard: Croston-style separation of
// demand size and timing, with SBA debiasing the rate and TSB decaying the
// occurrence probability every zero month (obsolescence-aware, for ranges
// that turn over). Damped-trend exponential smoothing (Gardner) is the
// classic hard-to-beat benchmark for the fast movers. ADIDA aggregates the
// lumpiest series to quarters, forecasts the aggregate, and disaggregates by
// the class seasonal shape. All operate on the DESEASONALIZED series (class
// index divided out) and reseasonalize on the way back, per the pooled-index
// evidence (Chen-Boylan): seasonality lives at class level, level at SKU
// level. Smoothing constants are not fitted per series (optimizing them buys
// little on short series); they come from ForecastParams.

/** Divide out the class index so level estimation is season-free. */
function deseasonalize(units: number[], startCalMonth: number, idx: SeasonalIndex, floor: number): number[] {
  return units.map((u, i) => {
    const si = idx[(startCalMonth + i) % 12]!;
    return u / (si > floor ? si : 1);
  });
}

/** Reseasonalize a flat/level forecast path onto the target months. */
function reseasonalize(path: number[], firstTargetCalMonth: number, idx: SeasonalIndex): number[] {
  return path.map((v, h) => nonNeg(v * idx[(firstTargetCalMonth + h) % 12]!));
}

/**
 * SBA: Croston's size/interval decomposition with the (1 - beta/2) debias.
 * Returns a flat demand-rate path (deseasonalized), reseasonalized by ctx.
 */
export const sba: Forecaster = {
  key: 'sba',
  forecast(units, startCalMonth, horizon, ctx, params) {
    const p = resolveParams(params);
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex, p.index_floor);
    let size: number | null = null;
    let interval: number | null = null;
    let sinceLast = 0;
    for (const u of d) {
      sinceLast += 1;
      if (u > 0) {
        size = size == null ? u : size + p.sba_alpha * (u - size);
        interval = interval == null ? sinceLast : interval + p.sba_beta * (sinceLast - interval);
        sinceLast = 0;
      }
    }
    const rate = size != null && interval != null && interval > 0 ? (1 - p.sba_beta / 2) * (size / interval) : 0;
    return reseasonalize(new Array(horizon).fill(rate), ctx.firstTargetCalMonth, ctx.seasonalIndex);
  },
};

/**
 * TSB: smooths occurrence probability EVERY month (decays through zero runs,
 * so a SKU that has stopped selling glides to zero instead of freezing).
 */
export const tsb: Forecaster = {
  key: 'tsb',
  forecast(units, startCalMonth, horizon, ctx, params) {
    const p = resolveParams(params);
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex, p.index_floor);
    let prob: number | null = null;
    let size: number | null = null;
    for (const u of d) {
      const occurred = u > 0 ? 1 : 0;
      prob = prob == null ? occurred : prob + p.tsb_beta * (occurred - prob);
      if (u > 0) size = size == null ? u : size + p.tsb_alpha * (u - size);
    }
    const rate = prob != null && size != null ? prob * size : 0;
    return reseasonalize(new Array(horizon).fill(rate), ctx.firstTargetCalMonth, ctx.seasonalIndex);
  },
};

/**
 * Damped-trend exponential smoothing (Gardner-McKenzie) on the
 * deseasonalized series, reseasonalized forward. phi < 1 flattens the trend
 * over the horizon so a few dozen noisy points can never extrapolate a runaway.
 */
export const dampedTrendIndex: Forecaster = {
  key: 'damped_trend_index',
  forecast(units, startCalMonth, horizon, ctx, params) {
    const p = resolveParams(params);
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex, p.index_floor);
    if (d.length === 0) return new Array(horizon).fill(0);
    let level = d[0]!;
    let trend = 0;
    for (let i = 1; i < d.length; i++) {
      const prevLevel = level;
      level = p.damped_alpha * d[i]! + (1 - p.damped_alpha) * (level + p.damped_phi * trend);
      trend = p.damped_beta * (level - prevLevel) + (1 - p.damped_beta) * p.damped_phi * trend;
    }
    const path: number[] = new Array(horizon);
    let phiSum = 0;
    for (let h = 0; h < horizon; h++) {
      phiSum += Math.pow(p.damped_phi, h + 1);
      path[h] = level + phiSum * trend;
    }
    return reseasonalize(path, ctx.firstTargetCalMonth, ctx.seasonalIndex);
  },
};

/**
 * ADIDA: aggregate the deseasonalized series into quarters (from the end),
 * SES the quarterly totals, and spread the quarterly rate back to months by
 * the class seasonal shape. Strongest on the lumpiest series, where monthly
 * timing is noise but the quarterly level is real.
 */
export const adida: Forecaster = {
  key: 'adida',
  forecast(units, startCalMonth, horizon, ctx, params) {
    const p = resolveParams(params);
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex, p.index_floor);
    // Quarter boundaries anchored to the END so the latest quarter is complete.
    const drop = d.length % 3;
    const q: number[] = [];
    for (let i = drop; i + 3 <= d.length; i += 3) q.push(d[i]! + d[i + 1]! + d[i + 2]!);
    if (q.length === 0) return runRateIndex.forecast(units, startCalMonth, horizon, ctx, params);
    let level = q[0]!;
    for (let i = 1; i < q.length; i++) level = level + p.adida_alpha * (q[i]! - level);
    const monthlyRate = level / 3;
    return reseasonalize(new Array(horizon).fill(monthlyRate), ctx.firstTargetCalMonth, ctx.seasonalIndex);
  },
};

/** Long-run mean rate (all months), reseasonalized - the second floor. */
export const meanRateIndex: Forecaster = {
  key: 'mean_rate_index',
  forecast(units, startCalMonth, horizon, ctx, params) {
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex, resolveParams(params).index_floor);
    const level = d.length > 0 ? d.reduce((a, b) => a + b, 0) / d.length : 0;
    return reseasonalize(new Array(horizon).fill(level), ctx.firstTargetCalMonth, ctx.seasonalIndex);
  },
};

/**
 * Equal-weight mean of the four researched methods - the combination-puzzle
 * contestant (fixed weights; never fit combination weights on a few dozen points).
 */
export const combo: Forecaster = {
  key: 'combo',
  forecast(units, startCalMonth, horizon, ctx, params) {
    const parts = [sba, tsb, dampedTrendIndex, adida].map((f) =>
      f.forecast(units, startCalMonth, horizon, ctx, params),
    );
    const out: number[] = new Array(horizon).fill(0);
    for (const p of parts) for (let h = 0; h < horizon; h++) out[h]! += p[h]! / parts.length;
    return out;
  },
};

// ── SBC demand classification (routing diagnostic) ───────────────────────

export type DemandClass = 'smooth' | 'erratic' | 'intermittent' | 'lumpy' | 'dead';

/** Fixed cut-offs from the Syntetos-Boylan-Croston demand classification (Syntetos, Boylan and Croston 2005), not tuning. */
export const SBC_ADI_CUTOFF = 1.32;
export const SBC_CV2_CUTOFF = 0.49;

/**
 * Classify a series by ADI (mean inter-demand interval) and CV^2 of the
 * non-zero sizes, per the Syntetos-Boylan scheme. Drives which methods are
 * plausible per cell and is reported in the backtest for interpretation.
 */
export function classifyDemand(units: number[]): { cls: DemandClass; adi: number | null; cv2: number | null } {
  const nz = units.filter((u) => u > 0);
  if (nz.length === 0) return { cls: 'dead', adi: null, cv2: null };
  const adi = units.length / nz.length;
  const mean = nz.reduce((a, b) => a + b, 0) / nz.length;
  const varc = nz.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nz.length;
  const cv2 = mean > 0 ? varc / (mean * mean) : 0;
  const cls: DemandClass =
    adi < SBC_ADI_CUTOFF ? (cv2 < SBC_CV2_CUTOFF ? 'smooth' : 'erratic') : cv2 < SBC_CV2_CUTOFF ? 'intermittent' : 'lumpy';
  return { cls, adi: Math.round(adi * 100) / 100, cv2: Math.round(cv2 * 100) / 100 };
}

/** The default fast/slow line, in mean units a month over the last year. */
export const DEFAULT_VELOCITY_SPLIT_UNITS_PER_MONTH = 8;

/** Velocity band for tournament cells: mean units/mo over the last year. */
export function velocityBand(units: number[], fastThreshold: number = DEFAULT_VELOCITY_SPLIT_UNITS_PER_MONTH): 'fast' | 'slow' {
  const k = Math.min(12, units.length);
  if (k === 0) return 'slow';
  let s = 0;
  for (let i = units.length - k; i < units.length; i++) s += units[i]!;
  return s / k >= fastThreshold ? 'fast' : 'slow';
}

/**
 * The tournament entry list, floors first (a winner must beat them to
 * matter). The backtest picks per (class x velocity band) cell.
 */
export const FORECASTERS: Forecaster[] = [
  seasonalNaive,
  meanRateIndex,
  runRate3m,
  runRateIndex,
  blendNaiveIndex,
  sba,
  tsb,
  dampedTrendIndex,
  adida,
  combo,
];

// ── Live-path assembly ───────────────────────────────────────────

/** Lookup by key for routing a SKU through its cell's winner. */
export const FORECASTER_BY_KEY: Map<string, Forecaster> = new Map(FORECASTERS.map((f) => [f.key, f]));

/** The safe global fallback when a cell has no winner. */
export const FALLBACK_FORECASTER = tsb;

/** Rebuild a gap-filled SkuSeries from a month map ({YYYY-MM: units}). */
export function seriesFromMonthMap(
  sku: string,
  classKey: string,
  months: Record<string, number>,
  nowMonth: string,
): SkuSeries | null {
  const keys = Object.keys(months)
    .filter((m) => m < nowMonth)
    .sort();
  if (keys.length === 0) return null;
  const start = keys[0]!;
  const lastClosed = monthAdd(nowMonth, -1);
  const n = monthDiff(start, lastClosed) + 1;
  if (n <= 0) return null;
  const units: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = months[monthAdd(start, i)];
    units[i] = typeof u === 'number' && Number.isFinite(u) && u > 0 ? u : 0;
  }
  return { sku, class_1: classKey, startMonth: start, units };
}

export interface LiveForecastRun {
  cells: {
    class_1: string;
    band: 'fast' | 'slow';
    winner: string;
    raw_winner: string;
    demoted: boolean;
    /** The raw winner's WAPE on this run. */
    wape_pct: number | null;
    /** The baseline (seasonal_naive) WAPE on this run. */
    baseline_wape_pct: number | null;
    /** Raw winner WAPE minus baseline (seasonal_naive) WAPE, in points; negative = winner better. */
    vs_baseline_pts: number | null;
    bias_pct: number | null;
    sku_count: number;
    holdout_actual_units: number;
  }[];
  forecasts: { sku: string; forecast: number[]; method: string }[];
  scored_skus: number;
  skipped_skus: number;
}

/**
 * Finish a tournament run: backtest -> FVA demotion -> per-SKU 12-month
 * forecasts from each cell's in-force winner. Demotion rule: a winner that
 * does not beat the baseline (seasonal_naive) on this run is demoted TO
 * seasonal_naive, so a cell's in-force method never scores worse than the
 * baseline. `params` tunes the seasonal index and the forecasters; pass the
 * same value the backtest was run with.
 */
export function runLiveForecast(
  series: SkuSeries[],
  backtest: import('./backtest').BacktestResult,
  nowMonth: string,
  horizon = 12,
  params?: Partial<ForecastParams>,
): LiveForecastRun {
  // Band on the backtest's own split so each SKU lands in a cell it scored.
  const split = backtest.velocity_split_units_per_month ?? DEFAULT_VELOCITY_SPLIT_UNITS_PER_MONTH;
  const indices = classSeasonalIndices(series, params);
  const winnerByCell = new Map<string, string>();
  const cells: LiveForecastRun['cells'] = [];
  for (const c of backtest.classes) {
    const baseline = c.scores.find((s) => s.method === 'seasonal_naive');
    const win = c.scores.find((s) => s.method === c.winner);
    const beatsBaseline =
      win?.wape_pct != null && baseline?.wape_pct != null
        ? win.wape_pct <= baseline.wape_pct
        : win?.wape_pct != null;
    const inForce = beatsBaseline ? c.winner : 'seasonal_naive';
    winnerByCell.set(`${c.class_1}|${c.band}`, inForce);
    cells.push({
      class_1: c.class_1,
      band: c.band,
      winner: inForce,
      raw_winner: c.winner,
      demoted: !beatsBaseline,
      wape_pct: win?.wape_pct ?? null,
      baseline_wape_pct: baseline?.wape_pct ?? null,
      vs_baseline_pts: c.vs_baseline_pts,
      bias_pct: win?.bias_pct ?? null,
      sku_count: c.sku_count,
      holdout_actual_units: c.holdout_actual_units,
    });
  }
  const firstTargetCalMonth = calMonth(nowMonth);
  const forecasts: LiveForecastRun['forecasts'] = [];
  for (const s of series) {
    const band = velocityBand(s.units, split);
    const key = winnerByCell.get(`${s.class_1}|${band}`);
    const f = (key ? FORECASTER_BY_KEY.get(key) : undefined) ?? FALLBACK_FORECASTER;
    const ctx = { seasonalIndex: indices.get(s.class_1) ?? FLAT_INDEX, firstTargetCalMonth };
    const fc = f
      .forecast(s.units, calMonth(s.startMonth), horizon, ctx, params)
      .map((v) => Math.round(v * 100) / 100);
    forecasts.push({ sku: s.sku, forecast: fc, method: f.key });
  }
  return { cells, forecasts, scored_skus: backtest.scored_skus, skipped_skus: backtest.skipped_skus };
}
