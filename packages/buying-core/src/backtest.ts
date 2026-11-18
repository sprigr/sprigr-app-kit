/**
 * buying-core - rolling-origin forecast backtest (pure).
 *
 * The decision instrument for the in-app forecast: every candidate method
 * (forecast.ts FORECASTERS) is evaluated on the SAME holdout - the
 * last `holdout` closed months - by training on everything strictly before
 * each origin (expanding window) and scoring horizons 1..N.
 *
 * Selection altitude: per (class x velocity band) CELL, not per
 * SKU - a 6-month holdout of a 0-2 units/month series is mostly noise, and
 * the literature (horses-for-courses / M-competition findings) favors
 * segment-level selection for short series. Metrics per cell per method:
 *  - WAPE  (sum|e| / sum actual): volume-weighted, the business metric;
 *  - MASE  (mean |e| / in-sample naive MAE): series-fair, robust at zeros,
 *          the cross-series tournament metric;
 *  - bias  (sum e / sum actual): positive = over-forecast.
 * Winner per cell: lowest WAPE with a simplicity tiebreak (earlier entry in
 * the roster wins ties within `winner_epsilon_pts`) - a complex method must EARN its
 * keep. `seasonal_naive` is the baseline (a same-month-last-year repeater), so
 * `vs_baseline_pts` reads directly as "how much better than the baseline".
 */

import {
  type Forecaster,
  type ForecastParams,
  type SkuSeries,
  type SeasonalIndex,
  type DemandClass,
  FLAT_INDEX,
  calMonth,
  monthAdd,
  classifyDemand,
  velocityBand,
} from './forecast';

export interface MethodScore {
  method: string;
  /** Σ|forecast - actual| over the cell holdout. */
  abs_err: number;
  /** Σ(forecast - actual): positive = over-forecast. */
  signed_err: number;
  /** Σ actual (the WAPE denominator). */
  actual_sum: number;
  /** Scored (series, origin, horizon) points. */
  points: number;
  /** abs_err / actual_sum * 100; null when the cell holdout had no sales. */
  wape_pct: number | null;
  /** signed_err / actual_sum * 100; null when no sales. */
  bias_pct: number | null;
  /** Mean absolute scaled error (vs in-sample one-step naive); null when unscorable. */
  mase: number | null;
}

export interface CellBacktest {
  class_1: string;
  band: 'fast' | 'slow';
  sku_count: number;
  holdout_actual_units: number;
  /** SBC demand-class mix of the cell's series (diagnostic). */
  demand_mix: Partial<Record<DemandClass, number>>;
  scores: MethodScore[];
  /** Method key with the lowest WAPE (simplicity tiebreak). */
  winner: string;
  /** Winner WAPE minus baseline (seasonal_naive) WAPE, in points; negative = winner better. */
  vs_baseline_pts: number | null;
}

export interface BacktestResult {
  holdout_months: number;
  horizons: number;
  /** Series long enough to score at least one point. */
  scored_skus: number;
  skipped_skus: number;
  classes: CellBacktest[];
  /** Volume-weighted overall score per method across all cells. */
  overall: MethodScore[];
}

export interface BacktestOptions {
  /** Closed months held out at the end of each series and scored. */
  holdout: number;
  /** Horizons scored per origin (1..horizons months ahead). */
  horizons: number;
  /**
   * A later roster entry replaces the current best only when its WAPE is
   * lower by more than this many points, so near-ties go to the earlier
   * (simpler) entry. 0 lets any improvement win. Default 0.5.
   */
  winner_epsilon_pts?: number;
  /**
   * Training months required before an origin is scored; a series with
   * fewer than this plus one closed months is skipped. Default 6.
   */
  min_train_months?: number;
  /** Forecast tuning handed to every forecaster; see ForecastParams for the defaults. */
  params?: Partial<ForecastParams>;
}

/** The defaults rollingBacktest uses for the optional BacktestOptions fields. */
export const DEFAULT_BACKTEST_OPTIONS = {
  winner_epsilon_pts: 0.5,
  min_train_months: 6,
} as const;

interface Acc {
  abs: number;
  signed: number;
  actual: number;
  points: number;
  qSum: number;
  qPoints: number;
}

const acc = (): Acc => ({ abs: 0, signed: 0, actual: 0, points: 0, qSum: 0, qPoints: 0 });

function finalize(method: string, a: Acc): MethodScore {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    method,
    abs_err: r2(a.abs),
    signed_err: r2(a.signed),
    actual_sum: r2(a.actual),
    points: a.points,
    wape_pct: a.actual > 0 ? r2((a.abs / a.actual) * 100) : null,
    bias_pct: a.actual > 0 ? r2((a.signed / a.actual) * 100) : null,
    mase: a.qPoints > 0 ? r2(a.qSum / a.qPoints) : null,
  };
}

/** In-sample one-step naive MAE of a training slice (MASE scale). */
function naiveMae(train: number[]): number {
  if (train.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < train.length; i++) s += Math.abs(train[i]! - train[i - 1]!);
  return s / (train.length - 1);
}

/**
 * Rolling-origin evaluation over tournament cells. Callers doing a strict
 * evaluation pass class indices computed from pre-holdout data only
 * (see trainSeries) so the backtest never peeks at the months it scores.
 * `classIndices` is used as given: build it with the same `params` as
 * `opts.params` when the index damping is tuned.
 */
export function rollingBacktest(
  series: SkuSeries[],
  forecasters: Forecaster[],
  classIndices: Map<string, SeasonalIndex>,
  opts: BacktestOptions,
): BacktestResult {
  const { holdout, horizons } = opts;
  const eps = opts.winner_epsilon_pts;
  const winnerEpsilonPts =
    typeof eps === 'number' && Number.isFinite(eps) && eps >= 0 ? eps : DEFAULT_BACKTEST_OPTIONS.winner_epsilon_pts;
  const minTrain = opts.min_train_months;
  // At least one training month, so every forecaster has something to read.
  const minTrainMonths =
    typeof minTrain === 'number' && Number.isFinite(minTrain) && minTrain >= 1
      ? Math.floor(minTrain)
      : DEFAULT_BACKTEST_OPTIONS.min_train_months;
  interface CellBox {
    class_1: string;
    band: 'fast' | 'slow';
    skus: Set<string>;
    actual: number;
    mix: Partial<Record<DemandClass, number>>;
    scores: Map<string, Acc>;
  }
  const cells = new Map<string, CellBox>();
  const overall = new Map<string, Acc>();
  let scoredSkus = 0;
  let skippedSkus = 0;

  for (const s of series) {
    const n = s.units.length;
    if (n < minTrainMonths + 1) {
      skippedSkus++;
      continue;
    }
    const firstCut = Math.max(minTrainMonths, n - holdout);
    if (firstCut >= n) {
      skippedSkus++;
      continue;
    }
    scoredSkus++;
    // Band + demand class from the TRAINING window only (no holdout peek).
    const trainAll = s.units.slice(0, firstCut);
    const band = velocityBand(trainAll);
    const dc = classifyDemand(trainAll).cls;
    const key = `${s.class_1}|${band}`;
    const cbox =
      cells.get(key) ??
      ({
        class_1: s.class_1,
        band,
        skus: new Set<string>(),
        actual: 0,
        mix: {},
        scores: new Map<string, Acc>(),
      } satisfies CellBox);
    cbox.skus.add(s.sku);
    cbox.mix[dc] = (cbox.mix[dc] ?? 0) + 1;
    cells.set(key, cbox);
    const index = classIndices.get(s.class_1) ?? FLAT_INDEX;
    const startCal = calMonth(s.startMonth);

    for (let cut = firstCut; cut < n; cut++) {
      const train = s.units.slice(0, cut);
      const scale = naiveMae(train);
      const h = Math.min(horizons, n - cut);
      const ctx = { seasonalIndex: index, firstTargetCalMonth: (startCal + cut) % 12 };
      for (const f of forecasters) {
        const fc = f.forecast(train, startCal, h, ctx, opts.params);
        const box = cbox.scores.get(f.key) ?? acc();
        const obox = overall.get(f.key) ?? acc();
        for (let i = 0; i < h; i++) {
          const actual = s.units[cut + i]!;
          const err = fc[i]! - actual;
          for (const b of [box, obox]) {
            b.abs += Math.abs(err);
            b.signed += err;
            b.actual += actual;
            b.points += 1;
            if (scale > 0) {
              b.qSum += Math.abs(err) / scale;
              b.qPoints += 1;
            }
          }
          // Cell actuals counted once (first method only) to avoid multiplying.
          if (f === forecasters[0]) cbox.actual += actual;
        }
        cbox.scores.set(f.key, box);
        overall.set(f.key, obox);
      }
    }
  }

  const order = forecasters.map((f) => f.key);
  const classes: CellBacktest[] = [];
  for (const cbox of cells.values()) {
    const scores = order.map((k) => finalize(k, cbox.scores.get(k) ?? acc()));
    const scoreable = scores.filter((sc) => sc.wape_pct != null);
    let winner = order[0]!;
    if (scoreable.length > 0) {
      let best = scoreable[0]!;
      for (const sc of scoreable) {
        if (sc.wape_pct! < best.wape_pct! - winnerEpsilonPts) best = sc;
      }
      winner = best.method;
    }
    const baseline = scores.find((sc) => sc.method === 'seasonal_naive');
    const win = scores.find((sc) => sc.method === winner);
    classes.push({
      class_1: cbox.class_1,
      band: cbox.band,
      sku_count: cbox.skus.size,
      holdout_actual_units: Math.round(cbox.actual),
      demand_mix: cbox.mix,
      scores,
      winner,
      vs_baseline_pts:
        baseline?.wape_pct != null && win?.wape_pct != null
          ? Math.round((win.wape_pct - baseline.wape_pct) * 100) / 100
          : null,
    });
  }
  classes.sort((a, b) => b.holdout_actual_units - a.holdout_actual_units);

  return {
    holdout_months: holdout,
    horizons,
    scored_skus: scoredSkus,
    skipped_skus: skippedSkus,
    classes,
    overall: order.map((k) => finalize(k, overall.get(k) ?? acc())),
  };
}

/**
 * Strict-evaluation helper: class indices computed ONLY from pre-holdout
 * months, so the backtest never peeks at the months it scores.
 */
export function trainSeries(series: SkuSeries[], holdout: number): SkuSeries[] {
  return series
    .map((s) => ({ ...s, units: s.units.slice(0, Math.max(0, s.units.length - holdout)) }))
    .filter((s) => s.units.length > 0);
}

/** Month label helper for reporting: the holdout window [from, to] given nowMonth. */
export function holdoutWindow(nowMonth: string, holdout: number): { from: string; to: string } {
  return { from: monthAdd(nowMonth, -holdout), to: monthAdd(nowMonth, -1) };
}
