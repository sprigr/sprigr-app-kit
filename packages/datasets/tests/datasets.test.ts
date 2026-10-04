import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPEND_RETRY_DELAYS_MS,
  DatasetAppendError,
  MAX_APPEND_ROWS,
  appendInBatches,
  appendWithRetry,
  datasetRows,
  isRetryableAppendError,
  type DatasetRow,
  type SprigrDatasetsApi,
} from '../src/index';

function rowsOf(n: number): DatasetRow[] {
  return Array.from({ length: n }, (_, i) => ({ row_key: `k${i}` }));
}

/** A datasets surface whose append answers from `answers` in call order
 *  (an Error is thrown), then `{ ok: true, rows }`. */
function surface(answers: Array<Error | { ok: boolean; rows: number } | undefined> = []) {
  const calls: Array<{ dataset: string; rows: number }> = [];
  const datasets: SprigrDatasetsApi = {
    append: vi.fn(async (dataset: string, rows: DatasetRow[]) => {
      calls.push({ dataset, rows: rows.length });
      if (answers.length > 0) {
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return a as { ok: boolean; rows: number };
      }
      return { ok: true, rows: rows.length };
    }),
  };
  return { datasets, calls };
}

const err500 = () => new Error('env.SPRIGR.datasets.append failed: 500 put: We encountered an internal error. Please try again. (10001)');
const err400 = () => new Error('env.SPRIGR.datasets.append failed: 400 contract_violation');

afterEach(() => vi.restoreAllMocks());

describe('datasetRows', () => {
  it('moves objectID to row_key and stamps imported_at as epoch ms', () => {
    const out = datasetRows([{ objectID: 'a', date: '2026-10-01', clicks: 3 }], 1_700_000_000_000);
    expect(out).toEqual([{ row_key: 'a', date: '2026-10-01', clicks: 3, imported_at: 1_700_000_000_000 }]);
    expect(out[0]).not.toHaveProperty('objectID');
  });

  it('overwrites an imported_at the doc already carries', () => {
    const out = datasetRows([{ objectID: 'a', imported_at: '2026-10-01T00:00:00Z' }], 5);
    expect(out[0]!.imported_at).toBe(5);
  });

  it('takes a per-doc import time', () => {
    const docs = [
      { objectID: 'a', imported_at: '2026-10-01T00:00:00.000Z' },
      { objectID: 'b', imported_at: '2026-10-02T00:00:00.000Z' },
    ];
    const out = datasetRows(docs, (d) => Date.parse(d.imported_at));
    expect(out.map((r) => r.imported_at)).toEqual([Date.parse('2026-10-01T00:00:00.000Z'), Date.parse('2026-10-02T00:00:00.000Z')]);
  });
});

describe('isRetryableAppendError', () => {
  it('retries a 5xx and nothing else', () => {
    expect(isRetryableAppendError(err500())).toBe(true);
    expect(isRetryableAppendError(new Error('append failed: 503 unavailable'))).toBe(true);
    expect(isRetryableAppendError(err400())).toBe(false);
    expect(isRetryableAppendError(new Error('append failed: 5000 rows'))).toBe(false);
    expect(isRetryableAppendError(new DatasetAppendError('append to x returned ok:false for 1 rows'))).toBe(false);
    expect(isRetryableAppendError('append failed: 502 bad gateway')).toBe(true);
  });
});

describe('appendWithRetry', () => {
  it('returns the answer of a first-time success without sleeping', async () => {
    const { datasets } = surface();
    const sleeps: number[] = [];
    const res = await appendWithRetry(datasets, 'ds', rowsOf(3), { sleep: async (ms) => { sleeps.push(ms); } });
    expect(res).toEqual({ ok: true, rows: 3 });
    expect(sleeps).toEqual([]);
  });

  it('retries a 5xx after each delay, then succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { datasets, calls } = surface([err500(), err500()]);
    const sleeps: number[] = [];
    const res = await appendWithRetry(datasets, 'ds', rowsOf(2), { sleep: async (ms) => { sleeps.push(ms); }, logPrefix: '[x-import]' });
    expect(res.rows).toBe(2);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([...APPEND_RETRY_DELAYS_MS]);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[x-import\] append to "ds" failed \(.*500 put.*\); retry 1 in 500 ms$/);
  });

  it('throws a 5xx that outlasts every retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { datasets, calls } = surface([err500(), err500(), err500()]);
    const sleeps: number[] = [];
    await expect(appendWithRetry(datasets, 'ds', rowsOf(1), { sleep: async (ms) => { sleeps.push(ms); } })).rejects.toThrow(/500 put/);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 2_000]);
  });

  it('never retries a 4xx', async () => {
    const { datasets, calls } = surface([err400()]);
    const sleep = vi.fn(async () => {});
    await expect(appendWithRetry(datasets, 'ds', rowsOf(1), { sleep })).rejects.toThrow(/400 contract_violation/);
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honours custom delays', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { datasets, calls } = surface([err500(), err500()]);
    await expect(appendWithRetry(datasets, 'ds', rowsOf(1), { delays: [1], sleep: async () => {} })).rejects.toThrow(/500/);
    expect(calls).toHaveLength(2);
  });

  it('throws DatasetAppendError on ok:false, without retrying', async () => {
    const { datasets, calls } = surface([{ ok: false, rows: 0 }]);
    const p = appendWithRetry(datasets, 'ds', rowsOf(4), { sleep: async () => {} });
    await expect(p).rejects.toBeInstanceOf(DatasetAppendError);
    await expect(appendWithRetry(surface([undefined]).datasets, 'ds', rowsOf(4))).rejects.toThrow('append to ds returned ok:false for 4 rows');
    expect(calls).toHaveLength(1);
  });

  it('returns ok:false as-is with requireOk false', async () => {
    const { datasets } = surface([{ ok: false, rows: 0 }]);
    await expect(appendWithRetry(datasets, 'ds', rowsOf(1), { requireOk: false })).resolves.toEqual({ ok: false, rows: 0 });
  });

  it('refuses more than MAX_APPEND_ROWS rows before calling the platform', async () => {
    const { datasets, calls } = surface();
    await expect(appendWithRetry(datasets, 'ds', rowsOf(MAX_APPEND_ROWS + 1))).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe('appendInBatches', () => {
  it('splits into appends of at most 1,000 rows and sums the stored count', async () => {
    const { datasets, calls } = surface();
    const n = await appendInBatches(datasets, 'ds', rowsOf(2_500));
    expect(n).toBe(2_500);
    expect(calls.map((c) => c.rows)).toEqual([1_000, 1_000, 500]);
  });

  it('makes no call for no rows', async () => {
    const { datasets, calls } = surface();
    await expect(appendInBatches(datasets, 'ds', [])).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('takes a smaller batch size and refuses one over the cap', async () => {
    const { datasets, calls } = surface();
    await appendInBatches(datasets, 'ds', rowsOf(5), { batchSize: 2 });
    expect(calls.map((c) => c.rows)).toEqual([2, 2, 1]);
    await expect(appendInBatches(datasets, 'ds', rowsOf(5), { batchSize: 1_001 })).rejects.toBeInstanceOf(RangeError);
    await expect(appendInBatches(datasets, 'ds', rowsOf(5), { batchSize: 0 })).rejects.toBeInstanceOf(RangeError);
  });

  it('keeps at most `concurrency` appends in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const datasets: SprigrDatasetsApi = {
      append: async (_d, rows) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return { ok: true, rows: rows.length };
      },
    };
    await expect(appendInBatches(datasets, 'ds', rowsOf(9), { batchSize: 1, concurrency: 3 })).resolves.toBe(9);
    expect(peak).toBe(3);
  });

  it('runs one at a time by default and stops at the first failure', async () => {
    const { datasets, calls } = surface([{ ok: true, rows: 1 }, err400()]);
    await expect(appendInBatches(datasets, 'ds', rowsOf(4), { batchSize: 1 })).rejects.toThrow(/400/);
    expect(calls).toHaveLength(2);
  });

  it('retries a 5xx inside a batch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { datasets, calls } = surface([err500()]);
    const sleeps: number[] = [];
    await expect(appendInBatches(datasets, 'ds', rowsOf(1_200), { sleep: async (ms) => { sleeps.push(ms); } })).resolves.toBe(1_200);
    expect(calls.map((c) => c.rows)).toEqual([1_000, 1_000, 200]);
    expect(sleeps).toEqual([500]);
  });

  it('counts a missing rows answer as 0 with requireOk false', async () => {
    const { datasets } = surface([{ ok: false, rows: 0 }]);
    await expect(appendInBatches(datasets, 'ds', rowsOf(3), { requireOk: false })).resolves.toBe(0);
  });
});
