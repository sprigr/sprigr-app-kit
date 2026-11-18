import { describe, it, expect } from 'vitest';
import {
  monthAdd,
  monthDiff,
  calMonth,
  buildSeries,
  classSeasonalIndices,
  seasonalNaive,
  runRate3m,
  runRateIndex,
  blendNaiveIndex,
  FLAT_INDEX,
  type MonthlyPoint,
} from '../src/forecast';
import { rollingBacktest, trainSeries, holdoutWindow } from '../src/backtest';

// ── Month math ────────────────────────────────────────────────────────────

describe('month math', () => {
  it('adds and subtracts across year boundaries', () => {
    expect(monthAdd('2026-01', -2)).toBe('2025-11');
    expect(monthAdd('2025-11', 3)).toBe('2026-02');
    expect(monthAdd('2026-12', 1)).toBe('2027-01');
  });
  it('diffs months', () => {
    expect(monthDiff('2025-11', '2026-02')).toBe(3);
    expect(monthDiff('2026-02', '2025-11')).toBe(-3);
  });
  it('calendar month index', () => {
    expect(calMonth('2026-01')).toBe(0);
    expect(calMonth('2026-12')).toBe(11);
  });
});

// ── Series building ───────────────────────────────────────────────────────

describe('buildSeries', () => {
  const attr = new Map([['A', 'CLASS_R'], ['B', 'CLASS_R']]);

  it('gap-fills missing months with zero and excludes the current month', () => {
    const rows: MonthlyPoint[] = [
      { sku: 'A', month: '2026-01', units_sold: 5 },
      // 2026-02 missing (activity-filtered upstream) -> must become 0
      { sku: 'A', month: '2026-03', units_sold: 3 },
      { sku: 'A', month: '2026-07', units_sold: 99 }, // current month -> dropped
    ];
    const [s] = buildSeries(rows, attr, '2026-07');
    expect(s!.startMonth).toBe('2026-01');
    // Jan..Jun closed months: 5, 0, 3, 0, 0, 0
    expect(s!.units).toEqual([5, 0, 3, 0, 0, 0]);
  });

  it('drops SKUs with no closed-month rows', () => {
    const rows: MonthlyPoint[] = [{ sku: 'B', month: '2026-07', units_sold: 4 }];
    expect(buildSeries(rows, attr, '2026-07')).toEqual([]);
  });
});

// ── Class seasonality ─────────────────────────────────────────────────────

function seasonalSeries(sku: string, cls: string, years: number, peak: number[]): ReturnType<typeof buildSeries>[0] {
  // Jan-start series: `peak` is 12 calendar multipliers on a base of 10/mo.
  const units: number[] = [];
  for (let y = 0; y < years; y++) for (let m = 0; m < 12; m++) units.push(Math.round(10 * peak[m]!));
  return { sku, class_1: cls, startMonth: `${2023 + 0}-01`, units };
}

describe('classSeasonalIndices', () => {
  const YEAR_END_PEAK_S = [1.6, 1.3, 1.0, 0.7, 0.5, 0.4, 0.4, 0.5, 0.8, 1.2, 1.6, 1.9]; // peak at the turn of the year

  it('recovers a pooled seasonal shape from several SKUs', () => {
    const series = [1, 2, 3, 4].map((i) => seasonalSeries(`W${i}`, 'CLASS_R', 3, YEAR_END_PEAK_S));
    const idx = classSeasonalIndices(series).get('CLASS_R')!;
    // December (index 11) must be well above June (index 5). With 4 SKUs x 3
    // years (n=12 per bucket) damping n/(n+12) keeps ~half the raw swing.
    expect(idx[11]!).toBeGreaterThan(1.35);
    expect(idx[5]!).toBeLessThan(0.75);
    // Mean-1 normalization.
    const mean = idx.reduce((a, b) => a + b, 0) / 12;
    expect(mean).toBeCloseTo(1, 6);
  });

  it('damps a thin class toward flat', () => {
    // One SKU, one year: n=3 per calendar month bucket is << damping K.
    const series = [seasonalSeries('X', 'CLASS_Thin', 1, YEAR_END_PEAK_S)];
    const idx = classSeasonalIndices(series).get('CLASS_Thin')!;
    for (const v of idx) {
      expect(v).toBeGreaterThan(0.9);
      expect(v).toBeLessThan(1.15);
    }
  });

  it('zero-sales class gets a flat curve', () => {
    const series = [{ sku: 'Z', class_1: 'CLASS_Dead', startMonth: '2025-01', units: [0, 0, 0] }];
    expect(classSeasonalIndices(series).get('CLASS_Dead')).toEqual(FLAT_INDEX);
  });
});

// ── Forecasters ───────────────────────────────────────────────────────────

describe('forecasters', () => {
  const ctx = { seasonalIndex: FLAT_INDEX, firstTargetCalMonth: 0 };

  it('seasonal_naive repeats same month last year; falls back on short series', () => {
    const units = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0, 0]; // 14 months
    // Next month is month idx 14 -> lookback idx 2 -> 3.
    expect(seasonalNaive.forecast(units, 0, 2, ctx)).toEqual([3, 4]);
    // 5-month series: falls back to mean of last 3 = (3+4+5)/3.
    expect(seasonalNaive.forecast([1, 2, 3, 4, 5], 0, 1, ctx)[0]).toBeCloseTo(4);
  });

  it('run_rate_3m is the trailing mean, flat', () => {
    expect(runRate3m.forecast([9, 0, 3, 6], 0, 3, ctx)).toEqual([3, 3, 3]);
  });

  it('run_rate_index deseasonalizes the level and reshapes forward', () => {
    // Index: Dec=2, Jun=0.5, others 1. Series ends Oct-Dec with Dec doubled by season.
    const idx = FLAT_INDEX.slice();
    idx[11] = 2;
    idx[5] = 0.5;
    // startCalMonth 9 (Oct), units Oct=10, Nov=10, Dec=20 -> deseasonalized level 10.
    const fc = runRateIndex.forecast([10, 10, 20], 9, 6, { seasonalIndex: idx, firstTargetCalMonth: 0 });
    expect(fc[0]).toBeCloseTo(10); // Jan
    expect(fc[5]).toBeCloseTo(5); // Jun at 0.5
  });

  it('blend is the average of naive and index run-rate', () => {
    const a = seasonalNaive.forecast([4, 4, 4], 0, 1, ctx)[0]!;
    const b = runRateIndex.forecast([4, 4, 4], 0, 1, ctx)[0]!;
    expect(blendNaiveIndex.forecast([4, 4, 4], 0, 1, ctx)[0]).toBeCloseTo((a + b) / 2);
  });
});

// ── Backtest ──────────────────────────────────────────────────────────────

describe('rollingBacktest', () => {
  const YEAR_END_PEAK = [2, 1.5, 1, 0.6, 0.4, 0.3, 0.3, 0.4, 0.8, 1.2, 1.8, 2.2];

  it('prefers seasonal methods on strongly seasonal series and beats run-rate', () => {
    const series = [1, 2, 3].map((i) => seasonalSeries(`W${i}`, 'CLASS_R', 3, YEAR_END_PEAK));
    const train = trainSeries(series, 6);
    const indices = classSeasonalIndices(train);
    const res = rollingBacktest(series, [seasonalNaive, runRate3m, runRateIndex, blendNaiveIndex], indices, {
      holdout: 6,
      horizons: 3,
    });
    const cls = res.classes.find((c) => c.class_1 === 'CLASS_R')!;
    const naive = cls.scores.find((s) => s.method === 'seasonal_naive')!;
    const rr = cls.scores.find((s) => s.method === 'run_rate_3m')!;
    // Deterministic seasonal repeat: naive is near-perfect, flat run-rate is not.
    expect(naive.wape_pct!).toBeLessThan(rr.wape_pct!);
    expect(cls.winner).not.toBe('run_rate_3m');
  });

  it('skips too-short series and reports counts', () => {
    const series = [
      { sku: 'S', class_1: 'CLASS_X', startMonth: '2026-01', units: [1, 2, 3] },
      seasonalSeries('L', 'CLASS_X', 2, YEAR_END_PEAK),
    ];
    const res = rollingBacktest(series, [seasonalNaive], classSeasonalIndices(series), { holdout: 3, horizons: 1 });
    expect(res.scored_skus).toBe(1);
    expect(res.skipped_skus).toBe(1);
  });

  it('bias sign convention: over-forecast is positive', () => {
    const series = [{ sku: 'B', class_1: 'CLASS_Y', startMonth: '2025-01', units: new Array(14).fill(10) }];
    const over: typeof seasonalNaive = {
      key: 'always_20',
      forecast: (_u, _s, h) => new Array(h).fill(20),
    };
    const res = rollingBacktest(series, [over], new Map(), { holdout: 3, horizons: 1 });
    expect(res.overall[0]!.bias_pct!).toBeGreaterThan(0);
  });

  it('holdoutWindow labels the scored months', () => {
    expect(holdoutWindow('2026-07', 3)).toEqual({ from: '2026-04', to: '2026-06' });
  });
});

// ── Researched methods (SBA / TSB / damped / ADIDA) + classification ──────

import { sba, tsb, dampedTrendIndex, adida, classifyDemand, velocityBand } from '../src/forecast';

describe('intermittent-demand forecasters', () => {
  const ctx = { seasonalIndex: FLAT_INDEX, firstTargetCalMonth: 0 };
  // 6 units every 3rd month: rate 2/mo, ADI 3.
  const lumpy = [0, 0, 6, 0, 0, 6, 0, 0, 6, 0, 0, 6, 0, 0, 6];

  it('sba estimates a debiased demand rate near the true rate', () => {
    const fc = sba.forecast(lumpy, 0, 3, ctx)[0]!;
    expect(fc).toBeGreaterThan(1.4);
    expect(fc).toBeLessThan(2.2); // true rate 2; SBA debias pulls slightly under
  });

  it('tsb decays toward zero over a long dead run while sba freezes', () => {
    const dying = [...lumpy, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const s = sba.forecast(dying, 0, 1, ctx)[0]!;
    const t = tsb.forecast(dying, 0, 1, ctx)[0]!;
    expect(t).toBeLessThan(s); // obsolescence awareness
    expect(t).toBeLessThan(tsb.forecast(lumpy, 0, 1, ctx)[0]!);
  });

  it('damped trend follows growth but flattens over the horizon', () => {
    const growing = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
    const fc = dampedTrendIndex.forecast(growing, 0, 12, ctx);
    // Tracks the climb (well above the series mean; SES level lags the tip).
    expect(fc[0]!).toBeGreaterThan(15.5);
    expect(fc[11]!).toBeGreaterThan(fc[0]!); // still rising
    const step1 = fc[1]! - fc[0]!;
    const step11 = fc[11]! - fc[10]!;
    expect(step11).toBeLessThan(step1); // damping: increments shrink
  });

  it('adida recovers the quarterly level under monthly timing noise', () => {
    // 9/quarter with jittered monthly timing.
    const jitter = [0, 9, 0, 3, 3, 3, 9, 0, 0, 0, 0, 9, 3, 0, 6];
    const fc = adida.forecast(jitter, 0, 1, ctx)[0]!;
    expect(fc).toBeGreaterThan(2);
    expect(fc).toBeLessThan(4); // true monthly rate 3
  });
});

describe('SBC classification + velocity band', () => {
  it('classifies the quadrants', () => {
    expect(classifyDemand([5, 6, 5, 6, 5, 6]).cls).toBe('smooth');
    expect(classifyDemand([0, 0, 6, 0, 0, 6, 0, 0, 6]).cls).toBe('intermittent');
    expect(classifyDemand([0, 0, 1, 0, 0, 30, 0, 0, 1]).cls).toBe('lumpy');
    expect(classifyDemand([0, 0, 0, 0]).cls).toBe('dead');
  });
  it('bands velocity on the last year', () => {
    expect(velocityBand(new Array(12).fill(10))).toBe('fast');
    expect(velocityBand(new Array(12).fill(2))).toBe('slow');
  });
});

describe('backtest cells', () => {
  it('splits cells by band and reports mase + demand mix', () => {
    const YEAR_END_PEAK = [2, 1.5, 1, 0.6, 0.4, 0.3, 0.3, 0.4, 0.8, 1.2, 1.8, 2.2];
    const fast = seasonalSeries('F', 'CLASS_R', 3, YEAR_END_PEAK); // base 10/mo -> fast
    const slow = { sku: 'S', class_1: 'CLASS_R', startMonth: '2023-01', units: fast.units.map((u) => (u > 15 ? 1 : 0)) };
    const res = rollingBacktest([fast, slow], [seasonalNaive, runRate3m], classSeasonalIndices([fast, slow]), { holdout: 4, horizons: 2 });
    const bands = res.classes.map((c) => c.band).sort();
    expect(bands).toEqual(['fast', 'slow']);
    const fastCell = res.classes.find((c) => c.band === 'fast')!;
    expect(fastCell.scores[0]!.mase).not.toBeNull();
    expect(Object.keys(fastCell.demand_mix).length).toBeGreaterThan(0);
  });
});

// ── Live path: month-map series, FVA demotion, winner routing ──────

import { seriesFromMonthMap, runLiveForecast, FALLBACK_FORECASTER } from '../src/forecast';

describe('seriesFromMonthMap', () => {
  it('rebuilds a gap-filled closed-month series from scratch JSON', () => {
    const s = seriesFromMonthMap('A', 'CLASS_X', { '2026-01': 5, '2026-03': 3, '2026-07': 99 }, '2026-07')!;
    expect(s.startMonth).toBe('2026-01');
    expect(s.units).toEqual([5, 0, 3, 0, 0, 0]); // Jan..Jun; Jul (current) dropped
  });
  it('null when nothing closed', () => {
    expect(seriesFromMonthMap('A', 'CLASS_X', { '2026-07': 4 }, '2026-07')).toBeNull();
  });
});

describe('runLiveForecast', () => {
  const YEAR_END_PEAK = [2, 1.5, 1, 0.6, 0.4, 0.3, 0.3, 0.4, 0.8, 1.2, 1.8, 2.2];

  it('routes SKUs through their cell winner and demotes losers to seasonal_naive', () => {
    const series = [1, 2, 3].map((i) => seasonalSeries(`W${i}`, 'CLASS_R', 3, YEAR_END_PEAK));
    const indices = classSeasonalIndices(trainSeries(series, 6));
    const bt = rollingBacktest(series, [seasonalNaive, runRate3m], indices, { holdout: 6, horizons: 3 });
    const live = runLiveForecast(series, bt, '2026-01', 12);
    expect(live.forecasts).toHaveLength(3);
    expect(live.forecasts[0]!.forecast).toHaveLength(12);
    for (const c of live.cells) {
      // Demotion invariant: a demoted cell's in-force winner IS seasonal_naive.
      if (c.demoted) expect(c.winner).toBe('seasonal_naive');
      // In-force winner never scores worse than the feed baseline on this run.
      if (c.wape_pct != null && c.feed_wape_pct != null && !c.demoted) {
        expect(c.wape_pct).toBeLessThanOrEqual(c.feed_wape_pct);
      }
    }
  });

  it('falls back to tsb for a SKU whose cell has no tournament result', () => {
    // One long seasonal series scored; one short series skipped by the
    // backtest (its cell then has no winner entry for its band).
    const scored = seasonalSeries('L', 'CLASS_A', 3, YEAR_END_PEAK);
    const short = { sku: 'S', class_1: 'CLASS_B', startMonth: '2026-03', units: [1, 2, 3, 4] };
    const bt = rollingBacktest([scored], [seasonalNaive, runRate3m], new Map(), { holdout: 6, horizons: 3 });
    const live = runLiveForecast([scored, short], bt, '2026-07', 12);
    const sf = live.forecasts.find((f) => f.sku === 'S')!;
    expect(sf.method).toBe(FALLBACK_FORECASTER.key);
  });
});
