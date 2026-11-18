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
 *    months. The upstream feed drops all-zero months (activity filter), so
 *    gap-filling with zeros is essential - a missing month IS a zero-sales
 *    month for any SKU that has already had activity.
 *  - Seasonality is POOLED per class: per-SKU monthly data is
 *    far too sparse to fit 12 indices per SKU, but consumable and apparel classes
 *    have strong, stable seasonal shapes. Indices are damped toward 1 by
 *    sample size so a thin class doesn't get a wild curve.
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
    // Start at the first month with any recorded row (the feed only emits
    // active months, so the first row is the SKU's first activity).
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
 * Damping constant: an index estimated from n SKU-months is shrunk toward 1
 * by n/(n+K). K=12 means a calendar-month bucket needs a full year of
 * SKU-month observations to earn half its raw seasonal swing - a thin class
 * (one young SKU) stays near flat, while a real class (dozens of SKUs over
 * 3 years, n in the hundreds) keeps nearly its full curve.
 */
export const INDEX_DAMPING_K = 12;

/**
 * Pooled seasonal indices per class. For each class and calendar
 * month: index = (mean units across that class's SKU-months landing on that
 * calendar month) / (class's overall mean). Damped toward 1 with weight
 * n/(n+K) so classes with little data get a nearly flat curve. Classes with
 * zero total sales get a flat curve.
 */
export function classSeasonalIndices(series: SkuSeries[]): Map<string, SeasonalIndex> {
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
        const w = n / (n + INDEX_DAMPING_K);
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
   * Returns non-negative unit forecasts, length `horizon`.
   */
  forecast(units: number[], startCalMonth: number, horizon: number, ctx: ForecastContext): number[];
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
 * Feed-equivalent baseline: same calendar month last year; falls back to the
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
  forecast(units, startCalMonth, horizon, ctx) {
    const idx = ctx.seasonalIndex;
    const k = Math.min(3, units.length);
    let level = 0;
    if (k > 0) {
      let s = 0;
      for (let i = units.length - k; i < units.length; i++) {
        const cm = (startCalMonth + i) % 12;
        const si = idx[cm]! > 0.05 ? idx[cm]! : 1;
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
  forecast(units, startCalMonth, horizon, ctx) {
    const a = seasonalNaive.forecast(units, startCalMonth, horizon, ctx);
    const b = runRateIndex.forecast(units, startCalMonth, horizon, ctx);
    return a.map((v, i) => (v + b[i]!) / 2);
  },
};

// ── Research-selected methods ─────────────────
//
// SBA (Syntetos-Boylan Approximation) and TSB (Teunter-Syntetos-Babai) are
// the literature's intermittent-demand standard: Croston-style separation of
// demand size and timing, with SBA debiasing the rate and TSB decaying the
// occurrence probability every zero month (obsolescence-aware - right for
// model-year churn). Damped-trend exponential smoothing (Gardner) is the
// classic hard-to-beat benchmark for the fast movers. ADIDA aggregates the
// lumpiest series to quarters, forecasts the aggregate, and disaggregates by
// the class seasonal shape. All operate on the DESEASONALIZED series (class
// index divided out) and reseasonalize on the way back, per the pooled-index
// evidence (Chen-Boylan): seasonality lives at class level, level at SKU
// level. Fixed smoothing constants per the intermittent literature (0.05-0.3;
// optimizing them buys little on short series).

/** Divide out the class index so level estimation is season-free. */
function deseasonalize(units: number[], startCalMonth: number, idx: SeasonalIndex): number[] {
  return units.map((u, i) => {
    const si = idx[(startCalMonth + i) % 12]!;
    return u / (si > 0.05 ? si : 1);
  });
}

/** Reseasonalize a flat/level forecast path onto the target months. */
function reseasonalize(path: number[], firstTargetCalMonth: number, idx: SeasonalIndex): number[] {
  return path.map((v, h) => nonNeg(v * idx[(firstTargetCalMonth + h) % 12]!));
}

const SBA_ALPHA = 0.15; // demand-size smoothing
const SBA_BETA = 0.15; // inter-demand-interval smoothing
const TSB_ALPHA = 0.15; // demand-size smoothing
const TSB_BETA = 0.05; // occurrence-probability smoothing (small: off-season gaps must not kill it)

/**
 * SBA: Croston's size/interval decomposition with the (1 - beta/2) debias.
 * Returns a flat demand-rate path (deseasonalized), reseasonalized by ctx.
 */
export const sba: Forecaster = {
  key: 'sba',
  forecast(units, startCalMonth, horizon, ctx) {
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex);
    let size: number | null = null;
    let interval: number | null = null;
    let sinceLast = 0;
    for (const u of d) {
      sinceLast += 1;
      if (u > 0) {
        size = size == null ? u : size + SBA_ALPHA * (u - size);
        interval = interval == null ? sinceLast : interval + SBA_BETA * (sinceLast - interval);
        sinceLast = 0;
      }
    }
    const rate = size != null && interval != null && interval > 0 ? (1 - SBA_BETA / 2) * (size / interval) : 0;
    return reseasonalize(new Array(horizon).fill(rate), ctx.firstTargetCalMonth, ctx.seasonalIndex);
  },
};

/**
 * TSB: smooths occurrence probability EVERY month (decays through zero runs,
 * so a dying model-year SKU glides to zero instead of freezing).
 */
export const tsb: Forecaster = {
  key: 'tsb',
  forecast(units, startCalMonth, horizon, ctx) {
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex);
    let prob: number | null = null;
    let size: number | null = null;
    for (const u of d) {
      const occurred = u > 0 ? 1 : 0;
      prob = prob == null ? occurred : prob + TSB_BETA * (occurred - prob);
      if (u > 0) size = size == null ? u : size + TSB_ALPHA * (u - size);
    }
    const rate = prob != null && size != null ? prob * size : 0;
    return reseasonalize(new Array(horizon).fill(rate), ctx.firstTargetCalMonth, ctx.seasonalIndex);
  },
};

const DAMPED_ALPHA = 0.2;
const DAMPED_BETA = 0.05;
const DAMPED_PHI = 0.9;

/**
 * Damped-trend exponential smoothing (Gardner-McKenzie) on the
 * deseasonalized series, reseasonalized forward. phi < 1 flattens the trend
 * over the horizon so a few dozen noisy points can never extrapolate a runaway.
 */
export const dampedTrendIndex: Forecaster = {
  key: 'damped_trend_index',
  forecast(units, startCalMonth, horizon, ctx) {
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex);
    if (d.length === 0) return new Array(horizon).fill(0);
    let level = d[0]!;
    let trend = 0;
    for (let i = 1; i < d.length; i++) {
      const prevLevel = level;
      level = DAMPED_ALPHA * d[i]! + (1 - DAMPED_ALPHA) * (level + DAMPED_PHI * trend);
      trend = DAMPED_BETA * (level - prevLevel) + (1 - DAMPED_BETA) * DAMPED_PHI * trend;
    }
    const path: number[] = new Array(horizon);
    let phiSum = 0;
    for (let h = 0; h < horizon; h++) {
      phiSum += Math.pow(DAMPED_PHI, h + 1);
      path[h] = level + phiSum * trend;
    }
    return reseasonalize(path, ctx.firstTargetCalMonth, ctx.seasonalIndex);
  },
};

const ADIDA_ALPHA = 0.2;

/**
 * ADIDA: aggregate the deseasonalized series into quarters (from the end),
 * SES the quarterly totals, and spread the quarterly rate back to months by
 * the class seasonal shape. Strongest on the lumpiest series, where monthly
 * timing is noise but the quarterly level is real.
 */
export const adida: Forecaster = {
  key: 'adida',
  forecast(units, startCalMonth, horizon, ctx) {
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex);
    // Quarter boundaries anchored to the END so the latest quarter is complete.
    const drop = d.length % 3;
    const q: number[] = [];
    for (let i = drop; i + 3 <= d.length; i += 3) q.push(d[i]! + d[i + 1]! + d[i + 2]!);
    if (q.length === 0) return runRateIndex.forecast(units, startCalMonth, horizon, ctx);
    let level = q[0]!;
    for (let i = 1; i < q.length; i++) level = level + ADIDA_ALPHA * (q[i]! - level);
    const monthlyRate = level / 3;
    return reseasonalize(new Array(horizon).fill(monthlyRate), ctx.firstTargetCalMonth, ctx.seasonalIndex);
  },
};

/** Long-run mean rate (all months), reseasonalized - the second floor. */
export const meanRateIndex: Forecaster = {
  key: 'mean_rate_index',
  forecast(units, startCalMonth, horizon, ctx) {
    const d = deseasonalize(units, startCalMonth, ctx.seasonalIndex);
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
  forecast(units, startCalMonth, horizon, ctx) {
    const parts = [sba, tsb, dampedTrendIndex, adida].map((f) => f.forecast(units, startCalMonth, horizon, ctx));
    const out: number[] = new Array(horizon).fill(0);
    for (const p of parts) for (let h = 0; h < horizon; h++) out[h]! += p[h]! / parts.length;
    return out;
  },
};

// ── SBC demand classification (routing diagnostic) ───────────────────────

export type DemandClass = 'smooth' | 'erratic' | 'intermittent' | 'lumpy' | 'dead';

/** Syntetos-Boylan cutoffs. */
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

/** Velocity band for tournament cells: mean units/mo over the last year. */
export function velocityBand(units: number[], fastThreshold = 8): 'fast' | 'slow' {
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

/** Lookup by key for routing a SKU through its cell's persisted winner. */
export const FORECASTER_BY_KEY: Map<string, Forecaster> = new Map(FORECASTERS.map((f) => [f.key, f]));

/** The safe global fallback when a cell has no persisted winner. */
export const FALLBACK_FORECASTER = tsb;

/** Rebuild a gap-filled SkuSeries from a scratch month-map ({YYYY-MM: units}). */
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
    wape_pct: number | null;
    feed_wape_pct: number | null;
    vs_feed_pts: number | null;
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
 * does not beat seasonal_naive (the feed-equivalent) on this run is demoted
 * TO seasonal_naive - the forecast then matches feed behavior, so flipping
 * forecast_source can never do worse than the feed on a demoted cell.
 */
export function runLiveForecast(
  series: SkuSeries[],
  backtest: import('./backtest').BacktestResult,
  nowMonth: string,
  horizon = 12,
): LiveForecastRun {
  const indices = classSeasonalIndices(series);
  const winnerByCell = new Map<string, string>();
  const cells: LiveForecastRun['cells'] = [];
  for (const c of backtest.classes) {
    const feed = c.scores.find((s) => s.method === 'seasonal_naive');
    const win = c.scores.find((s) => s.method === c.winner);
    const beatsFeed =
      win?.wape_pct != null && feed?.wape_pct != null ? win.wape_pct <= feed.wape_pct : win?.wape_pct != null;
    const inForce = beatsFeed ? c.winner : 'seasonal_naive';
    winnerByCell.set(`${c.class_1}|${c.band}`, inForce);
    cells.push({
      class_1: c.class_1,
      band: c.band,
      winner: inForce,
      raw_winner: c.winner,
      demoted: !beatsFeed,
      wape_pct: win?.wape_pct ?? null,
      feed_wape_pct: feed?.wape_pct ?? null,
      vs_feed_pts: c.vs_feed_pts,
      bias_pct: win?.bias_pct ?? null,
      sku_count: c.sku_count,
      holdout_actual_units: c.holdout_actual_units,
    });
  }
  const firstTargetCalMonth = calMonth(nowMonth);
  const forecasts: LiveForecastRun['forecasts'] = [];
  for (const s of series) {
    const band = velocityBand(s.units);
    const key = winnerByCell.get(`${s.class_1}|${band}`);
    const f = (key ? FORECASTER_BY_KEY.get(key) : undefined) ?? FALLBACK_FORECASTER;
    const ctx = { seasonalIndex: indices.get(s.class_1) ?? FLAT_INDEX, firstTargetCalMonth };
    const fc = f.forecast(s.units, calMonth(s.startMonth), horizon, ctx).map((v) => Math.round(v * 100) / 100);
    forecasts.push({ sku: s.sku, forecast: fc, method: f.key });
  }
  return { cells, forecasts, scored_skus: backtest.scored_skus, skipped_skus: backtest.skipped_skus };
}
