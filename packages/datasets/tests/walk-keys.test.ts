import { describe, expect, it } from 'vitest';
import {
  FIRST_PAGE,
  MAX_TOMBSTONE_FRACTION,
  appFilesWalkKeyStore,
  completeWalk,
  finishWalk,
  recordWalkPage,
  type WalkKeyStore,
  type WalkScope,
} from '../src/walk-keys';

/** In-memory stand-in for an app's file store. */
function memoryStore() {
  const files = new Map<string, Uint8Array>();
  const store: WalkKeyStore = {
    get: async (key) => files.get(key) ?? null,
    put: async (key, bytes) => void files.set(key, bytes),
    delete: async (key) => void files.delete(key),
    list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
  return { files, store };
}

const scope = (date: string): WalkScope => ({ dir: 'demo-walk-keys/acct1/perf', date, keyPrefix: `perf-acct1-${date}-` });
const keys = (date: string, ids: string[]) => ids.map((id) => `perf-acct1-${date}-${id}`);

/** One complete walk of a date over pages of `ids`. Page positions follow the
 *  source's own cursor (here a page token), the first one being FIRST_PAGE. */
async function walk(store: WalkKeyStore, date: string, pages: string[][], opts: { truncated?: boolean } = {}) {
  let at = FIRST_PAGE;
  for (const [i, ids] of pages.entries()) {
    const next = i < pages.length - 1 ? `token-${i + 1}` : null;
    await recordWalkPage(store, scope(date), at, { next, truncated: opts.truncated ?? false, keys: keys(date, ids) });
    if (next) at = next;
  }
  const c = await completeWalk(store, scope(date));
  return c;
}

const D = '2026-09-10';
const WINDOW = '2026-09-08';

describe('a completed re-walk names the keys it no longer returns', () => {
  it('the first walk only becomes the baseline; the next one tombstones what it dropped', async () => {
    const { store } = memoryStore();
    const first = await walk(store, D, [['a', 'b'], ['c']]);
    expect(first.kind).toBe('first');
    await finishWalk(store, scope(D), first, WINDOW);

    const second = await walk(store, D, [['a', 'b'], ['d']]);
    expect(second).toMatchObject({ kind: 'tombstone', rowKeys: keys(D, ['c']), previous: 3 });
  });

  it('works for keys that are plain values, not hashes, and ignores keys of another date or source', async () => {
    const { store } = memoryStore();
    await finishWalk(store, scope(D), await walk(store, D, [['offer:1|AU', 'offer/2 NZ']]), WINDOW);
    const sc = scope(D);
    await recordWalkPage(store, sc, FIRST_PAGE, { next: null, truncated: false, keys: [...keys(D, ['offer:1|AU']), 'perf-acct2-2026-09-10-x', 'perf-acct1-2026-09-11-y'] });
    const c = await completeWalk(store, sc);
    expect(c).toMatchObject({ kind: 'tombstone', rowKeys: keys(D, ['offer/2 NZ']) });
  });

  it('a page position may be any string the source hands back (stored under a safe name)', async () => {
    const { files, store } = memoryStore();
    await recordWalkPage(store, scope(D), FIRST_PAGE, { next: 'CjQK/+=?&#%20weird token', truncated: false, keys: keys(D, ['a']) });
    await recordWalkPage(store, scope(D), 'CjQK/+=?&#%20weird token', { next: null, truncated: false, keys: keys(D, ['b']) });
    for (const k of files.keys()) expect(k).toMatch(/^demo-walk-keys\/acct1\/perf\/2026-09-10\/page-[0-9a-f]{32}\.json\.gz$/);
    expect(await completeWalk(store, scope(D))).toMatchObject({ kind: 'first' });
  });
});

describe('never deletes on doubt', () => {
  it('a broken chain (a page never recorded) deletes nothing', async () => {
    const { store } = memoryStore();
    await finishWalk(store, scope(D), await walk(store, D, [['a', 'b', 'c']]), WINDOW);
    await recordWalkPage(store, scope(D), FIRST_PAGE, { next: 'token-1', truncated: false, keys: keys(D, ['a']) });
    expect(await completeWalk(store, scope(D))).toMatchObject({ kind: 'skipped', reason: 'broken_chain' });
  });

  it('a truncated walk deletes nothing', async () => {
    const { store } = memoryStore();
    await finishWalk(store, scope(D), await walk(store, D, [['a', 'b', 'c']]), WINDOW);
    expect(await walk(store, D, [['a', 'b']], { truncated: true })).toMatchObject({ kind: 'skipped', reason: 'truncated' });
  });

  it(`refuses to delete more than ${MAX_TOMBSTONE_FRACTION * 100}% of the last set, and an empty answer`, async () => {
    const { store } = memoryStore();
    await finishWalk(store, scope(D), await walk(store, D, [['a', 'b', 'c', 'd']]), WINDOW);
    expect(await walk(store, D, [[]])).toMatchObject({ kind: 'skipped', reason: 'mass_drop', wouldDelete: 4 });
    expect(await walk(store, D, [['a']])).toMatchObject({ kind: 'skipped', reason: 'mass_drop', wouldDelete: 3 });
  });

  it('a skipped walk keeps the previous set as the baseline', async () => {
    const { store } = memoryStore();
    await finishWalk(store, scope(D), await walk(store, D, [['a', 'b', 'c', 'd']]), WINDOW);
    await finishWalk(store, scope(D), await walk(store, D, [['a']]), WINDOW);
    expect(await walk(store, D, [['a', 'b', 'c']])).toMatchObject({ kind: 'tombstone', rowKeys: keys(D, ['d']) });
  });

  it('a damaged stored set reads as no baseline, never as an empty one', async () => {
    const { files, store } = memoryStore();
    await finishWalk(store, scope(D), await walk(store, D, [['a', 'b']]), WINDOW);
    const done = [...files.keys()].find((k) => k.endsWith('/done.json.gz'))!;
    files.set(done, new Uint8Array([1, 2, 3]));
    expect(await walk(store, D, [['a']])).toMatchObject({ kind: 'first' });
  });
});

describe('storage stays bounded', () => {
  it('a completed walk leaves only its set; dates before the window are deleted', async () => {
    const { files, store } = memoryStore();
    await finishWalk(store, scope('2026-09-06'), await walk(store, '2026-09-06', [['a'], ['b']]), '2026-09-06');
    await finishWalk(store, scope(D), await walk(store, D, [['a'], ['b']]), '2026-09-06');
    expect([...files.keys()].filter((k) => k.includes('/page-'))).toEqual([]);
    expect([...files.keys()].sort()).toEqual(['demo-walk-keys/acct1/perf/2026-09-06/done.json.gz', 'demo-walk-keys/acct1/perf/2026-09-10/done.json.gz']);

    // The window moves past 09-06: the next completion of the same scope prunes it.
    await finishWalk(store, scope(D), await walk(store, D, [['a', 'b']]), WINDOW);
    expect([...files.keys()]).toEqual(['demo-walk-keys/acct1/perf/2026-09-10/done.json.gz']);
  });

  it('a date that will not be walked again keeps no set', async () => {
    const { files, store } = memoryStore();
    await finishWalk(store, scope('2026-09-01'), await walk(store, '2026-09-01', [['a']]), WINDOW);
    expect([...files.keys()]).toEqual([]);
  });
});

describe('appFilesWalkKeyStore', () => {
  /** Fakes of the app-sdk file helpers (getAppFile, putAppFile, deleteAppFile, listAppFiles). */
  function fakeFiles() {
    const files = new Map<string, string>();
    const calls: string[] = [];
    const notFound = Object.assign(new Error('app file get failed (404): not found'), { status: 404 });
    return {
      files,
      calls,
      fns: {
        getAppFile: async (_env: unknown, key: string) => { calls.push(`get ${key}`); const b = files.get(key); if (b === undefined) throw notFound; return { base64: b }; },
        putAppFile: async (_env: unknown, args: { key: string; base64: string }) => { calls.push(`put ${args.key}`); files.set(args.key, args.base64); return { ok: true }; },
        deleteAppFile: async (_env: unknown, key: string) => { calls.push(`delete ${key}`); files.delete(key); return { ok: true }; },
        listAppFiles: async (_env: unknown, prefix?: string) => ({ files: [...files.keys()].filter((k) => k.startsWith(prefix ?? '')).map((key) => ({ key })) }),
      },
    };
  }
  const ENV = { SPRIGR_INSTALL_TOKEN: 't', SPRIGR_PLATFORM_BASE: 'https://platform.example' };

  it('is null without the install token or the platform base (no store, no tombstones)', () => {
    const { fns } = fakeFiles();
    expect(appFilesWalkKeyStore({}, fns)).toBeNull();
    expect(appFilesWalkKeyStore({ SPRIGR_INSTALL_TOKEN: 't' }, fns)).toBeNull();
  });

  it('round-trips bytes through base64, reads a 404 as absent, and drives a whole walk', async () => {
    const { fns, calls } = fakeFiles();
    const store = appFilesWalkKeyStore(ENV, fns)!;
    expect(await store.get('nope')).toBeNull();
    await store.put('x', new Uint8Array([0, 1, 254, 255]));
    expect([...(await store.get('x'))!]).toEqual([0, 1, 254, 255]);
    await store.delete('x');
    expect(await store.get('x')).toBeNull();

    await finishWalk(store, scope(D), await walk(store, D, [['a', 'b'], ['c']]), WINDOW);
    expect(await walk(store, D, [['a', 'b']])).toMatchObject({ kind: 'tombstone', rowKeys: keys(D, ['c']) });
    expect(calls.some((c) => c.startsWith('put demo-walk-keys/'))).toBe(true);
  });

  it('rethrows any failure that is not a 404, so the page fails', async () => {
    const { fns } = fakeFiles();
    const store = appFilesWalkKeyStore(ENV, { ...fns, getAppFile: async () => { throw Object.assign(new Error('app file get failed (503)'), { status: 503 }); } })!;
    await expect(store.get('k')).rejects.toThrow(/503/);
  });
});
