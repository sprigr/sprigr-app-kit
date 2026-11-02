import { describe, expect, it } from 'vitest';
import { makeSyncState } from '../src/sync-state';
import { runResumablePage } from '../src/page-walker';
import { makeMockD1, type MockRow } from './mock-d1';
import type { D1Like } from '../src/types';

// sprigr-app-kit#255: a walk whose cursor does not move rewrote its
// sync_state row on every page only to refresh last_run_at (~19.5k D1 rows a
// day on prod, 16.9k of them xero-accounting's 15-minute ticks).

const HOUR = 60 * 60 * 1000;

/** Counts the upserts that reach D1. */
function countingDb(db: D1Like): { db: D1Like; writes: () => number } {
  let n = 0;
  return {
    db: {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (!/^\s*INSERT/i.test(sql)) return stmt;
        const wrap = (s: ReturnType<D1Like['prepare']>): ReturnType<D1Like['prepare']> => ({
          ...s,
          bind: (...args: unknown[]) => wrap(s.bind(...args)),
          run: async () => { n++; return s.run(); },
        });
        return wrap(stmt);
      },
    },
    writes: () => n,
  };
}

/** D1's datetime('now') shape, `YYYY-MM-DD HH:MM:SS` in UTC. */
function d1Time(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

async function walkStable(db: D1Like, pages: number, opts: { refreshUnchangedAfterMs?: number } = {}) {
  const state = makeSyncState({ db, table: 'sync_state' });
  const results = [];
  for (let i = 0; i < pages; i++) {
    results.push(await runResumablePage({
      state,
      resource: 'invoices',
      scope: 'tenant-1:inc',
      fetchPage: async () => ({ rows: [], nextCursor: null }),
      writeRows: async () => {},
      ...opts,
    }));
  }
  return results;
}

describe('runResumablePage: an unchanged cursor (#255)', () => {
  const fresh = (): MockRow => ({ resource: 'invoices', scope: 'tenant-1:inc', cursor: null, last_run_at: d1Time(Date.now() - 5 * 60_000) });

  it('without the option, every page still writes (unchanged default)', async () => {
    const mock = makeMockD1([fresh()]);
    const c = countingDb(mock.db);
    await walkStable(c.db, 10);
    expect(c.writes()).toBe(10);
  });

  it('with refreshUnchangedAfterMs, N pages over a recent row write nothing', async () => {
    const mock = makeMockD1([fresh()]);
    const c = countingDb(mock.db);
    const results = await walkStable(c.db, 10, { refreshUnchangedAfterMs: 6 * HOUR });
    expect(c.writes()).toBe(0);
    expect(results.every((r) => r.done && r.nextCursor === null)).toBe(true);
    expect(mock.state.rows.get('invoices tenant-1:inc')!.cursor).toBeNull();
  });

  it('still writes the first bookkeeping row when none exists, then skips', async () => {
    const mock = makeMockD1();
    const c = countingDb(mock.db);
    await walkStable(c.db, 10, { refreshUnchangedAfterMs: 6 * HOUR });
    expect(c.writes()).toBe(1);
    expect(mock.state.rows.has('invoices tenant-1:inc')).toBe(true);
  });

  it('refreshes last_run_at once the row is older than the interval, then skips', async () => {
    const mock = makeMockD1([{ ...fresh(), last_run_at: d1Time(Date.now() - 7 * HOUR) }]);
    const c = countingDb(mock.db);
    await walkStable(c.db, 10, { refreshUnchangedAfterMs: 6 * HOUR });
    expect(c.writes()).toBe(1);
  });

  it('writes when last_run_at cannot be parsed', async () => {
    const mock = makeMockD1([{ ...fresh(), last_run_at: 'not a time' }]);
    const c = countingDb(mock.db);
    await walkStable(c.db, 1, { refreshUnchangedAfterMs: 6 * HOUR });
    expect(c.writes()).toBe(1);
  });

  it('a stable non-null cursor (ordered-stream walk at its end) is skipped too', async () => {
    const mock = makeMockD1([{ ...fresh(), cursor: 'pos-42' }]);
    const c = countingDb(mock.db);
    const state = makeSyncState({ db: c.db, table: 'sync_state' });
    for (let i = 0; i < 5; i++) {
      const r = await runResumablePage({
        state, resource: 'invoices', scope: 'tenant-1:inc', refreshUnchangedAfterMs: 6 * HOUR,
        fetchPage: async (cursor) => ({ rows: [], nextCursor: cursor }),
        writeRows: async () => {},
      });
      expect(r.done).toBe(true);
    }
    expect(c.writes()).toBe(0);
    expect(mock.state.rows.get('invoices tenant-1:inc')!.cursor).toBe('pos-42');
  });

  it('a cursor that moves is written on every page, option or not', async () => {
    const mock = makeMockD1();
    const c = countingDb(mock.db);
    const state = makeSyncState({ db: c.db, table: 'sync_state' });
    for (let i = 1; i <= 4; i++) {
      await runResumablePage({
        state, resource: 'invoices', refreshUnchangedAfterMs: 6 * HOUR,
        fetchPage: async () => ({ rows: [{ i }], nextCursor: String(i) }),
        writeRows: async () => {},
      });
    }
    expect(c.writes()).toBe(4);
    expect(mock.state.rows.get('invoices ')!.cursor).toBe('4');
  });
});
