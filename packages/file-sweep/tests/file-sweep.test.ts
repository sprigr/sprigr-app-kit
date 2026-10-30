import { describe, expect, it } from 'vitest';
import { runFileSweep, type FileSweepOptions, type SweepFilesApi } from '../src/index';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-30T12:00:00Z');

interface StoredFile {
  key: string;
  bytes: number;
  uploaded: string;
}

/** An in-memory files store with the platform's list shape: pages of `pageSize`, a cursor, `truncated`. */
function fakeStore(initial: StoredFile[], pageSize = 3) {
  const objects = new Map(initial.map((f) => [f.key, f]));
  const calls = { list: 0, delete: [] as string[] };
  let failDeleteOn: string | null = null;
  const files: SweepFilesApi = {
    async list(prefix, opts) {
      calls.list++;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = opts?.cursor ? Number(opts.cursor) : 0;
      const page = keys.slice(start, start + pageSize).map((k) => objects.get(k)!);
      const end = start + page.length;
      return { files: page, truncated: end < keys.length, cursor: end < keys.length ? String(end) : undefined };
    },
    async delete(key) {
      if (key === failDeleteOn) throw new Error('storage refused');
      calls.delete.push(key);
      objects.delete(key);
      return { ok: true };
    },
  };
  return { files, objects, calls, failOn: (key: string | null) => { failDeleteOn = key; } };
}

function memoryState() {
  let raw: string | null = null;
  return { store: { read: async () => raw, write: async (r: string) => { raw = r; } }, peek: () => raw };
}

const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const OFFLOAD = /^read_file\/[a-z]+\/[0-9a-f]{40}\/[^/]+$/;
const sha = (n: number) => n.toString(16).padStart(40, '0');

function options(files: SweepFilesApi, state: FileSweepOptions['state'], over: Partial<FileSweepOptions> = {}): FileSweepOptions {
  return {
    files,
    prefixes: ['read_file/'],
    classify: (key) => (OFFLOAD.test(key) ? 'read_file' : null),
    isExpired: (uploadedMs, startedAt) => uploadedMs + 7 * DAY < startedAt,
    mode: 'delete',
    walkId: '2026-10-30',
    state,
    now: () => NOW,
    ...over,
  };
}

describe('runFileSweep', () => {
  it('deletes only expired entries the app classifies, and leaves fresh and unrecognised keys alone', async () => {
    const store = fakeStore([
      { key: `read_file/acme/${sha(1)}/old.ts`, bytes: 100, uploaded: at(10) },
      { key: `read_file/acme/${sha(2)}/new.ts`, bytes: 200, uploaded: at(1) },
      { key: 'read_file/acme/not-a-sha/old.ts', bytes: 300, uploaded: at(30) },
      { key: 'read_file/', bytes: 0, uploaded: at(30) },
      { key: `read_file/acme/${sha(3)}/no-time.ts`, bytes: 50, uploaded: 'garbage' },
    ]);
    const state = memoryState();

    const result = await runFileSweep(options(store.files, state.store));

    expect(store.calls.delete).toEqual([`read_file/acme/${sha(1)}/old.ts`]);
    expect([...store.objects.keys()].sort()).toEqual([
      'read_file/',
      'read_file/acme/not-a-sha/old.ts',
      `read_file/acme/${sha(2)}/new.ts`,
      `read_file/acme/${sha(3)}/no-time.ts`,
    ]);
    expect(result.done).toBe(true);
    expect(result.finished_now).toBe(true);
    expect(result.state?.deleted).toEqual({ read_file: { objects: 1, bytes: 100 } });
    expect(result.state?.skipped).toEqual({ objects: 2, bytes: 300 });
    expect(result.state?.seen.read_file).toEqual({ objects: 3, bytes: 350 });
  });

  it('report mode counts and samples what it would delete, and deletes nothing', async () => {
    const store = fakeStore([
      { key: `read_file/acme/${sha(1)}/a.ts`, bytes: 10, uploaded: at(9) },
      { key: `read_file/acme/${sha(2)}/b.ts`, bytes: 20, uploaded: at(8) },
      { key: `read_file/acme/${sha(3)}/c.ts`, bytes: 30, uploaded: at(2) },
    ]);
    const state = memoryState();

    const result = await runFileSweep(options(store.files, state.store, { mode: 'report', sampleSize: 1 }));

    expect(store.calls.delete).toEqual([]);
    expect(store.objects.size).toBe(3);
    expect(result.state?.expired).toEqual({ read_file: { objects: 2, bytes: 30 } });
    expect(result.state?.samples).toEqual([`read_file/acme/${sha(1)}/a.ts`]);
  });

  it('resumes across ticks under the listing cap, counting each page once', async () => {
    const seeded = Array.from({ length: 7 }, (_, i) => ({
      key: `read_file/acme/${sha(i + 1)}/f${i}.ts`, bytes: 1, uploaded: at(20),
    }));
    const store = fakeStore(seeded, 2);
    const state = memoryState();
    const opts = options(store.files, state.store, { mode: 'report', maxListingsPerTick: 2 });

    const first = await runFileSweep(opts);
    expect(first).toMatchObject({ done: false, finished_now: false, listings: 2 });
    const second = await runFileSweep(opts);
    expect(second).toMatchObject({ done: true, finished_now: true, listings: 2 });
    expect(second.state?.expired.read_file).toEqual({ objects: 7, bytes: 7 });

    // A finished walk is idle until a new walk id, then starts over.
    const third = await runFileSweep(opts);
    expect(third).toMatchObject({ done: true, finished_now: false, listings: 0 });
    const nextDay = await runFileSweep({ ...opts, walkId: '2026-10-31' });
    expect(nextDay.listings).toBeGreaterThan(0);
  });

  it('stops at the delete cap and finishes the page next tick without double counting', async () => {
    const seeded = Array.from({ length: 5 }, (_, i) => ({
      key: `read_file/acme/${sha(i + 1)}/f${i}.ts`, bytes: 1, uploaded: at(20),
    }));
    const store = fakeStore(seeded, 10);
    const state = memoryState();
    const opts = options(store.files, state.store, { maxDeletesPerTick: 2 });

    const first = await runFileSweep(opts);
    expect(first).toMatchObject({ done: false, deleted: 2 });
    const second = await runFileSweep(opts);
    expect(second).toMatchObject({ done: false, deleted: 2 });
    const third = await runFileSweep(opts);
    expect(third).toMatchObject({ done: true, deleted: 1 });
    expect(store.objects.size).toBe(0);
    expect(third.state?.deleted.read_file).toEqual({ objects: 5, bytes: 5 });
  });

  it('a failed delete ends the tick without throwing, and the walk resumes', async () => {
    const store = fakeStore([
      { key: `read_file/acme/${sha(1)}/a.ts`, bytes: 1, uploaded: at(20) },
      { key: `read_file/acme/${sha(2)}/b.ts`, bytes: 1, uploaded: at(20) },
    ]);
    store.failOn(`read_file/acme/${sha(2)}/b.ts`);
    const state = memoryState();
    const opts = options(store.files, state.store);

    const first = await runFileSweep(opts);
    expect(first).toMatchObject({ done: false, deleted: 1 });

    store.failOn(null);
    const second = await runFileSweep(opts);
    expect(second).toMatchObject({ done: true, deleted: 1 });
    expect(store.objects.size).toBe(0);
  });

  it('a mode change starts a fresh walk, so report counts never mix into delete counts', async () => {
    const store = fakeStore([{ key: `read_file/acme/${sha(1)}/a.ts`, bytes: 1, uploaded: at(20) }]);
    const state = memoryState();
    await runFileSweep(options(store.files, state.store, { mode: 'report' }));

    const result = await runFileSweep(options(store.files, state.store, { mode: 'delete' }));

    expect(result.finished_now).toBe(true);
    expect(result.state?.mode).toBe('delete');
    expect(result.state?.deleted.read_file).toEqual({ objects: 1, bytes: 1 });
  });

  it('does nothing when the budget is spent, and nothing in delete mode without a delete call', async () => {
    const store = fakeStore([{ key: `read_file/acme/${sha(1)}/a.ts`, bytes: 1, uploaded: at(20) }]);
    const spent = await runFileSweep(options(store.files, memoryState().store, { hasBudget: () => false }));
    expect(spent).toMatchObject({ listings: 0, deleted: 0, done: false });

    const listOnly: SweepFilesApi = { list: store.files.list };
    const noDelete = await runFileSweep(options(listOnly, memoryState().store));
    expect(noDelete).toMatchObject({ listings: 0, deleted: 0, state: null });
    expect(store.objects.size).toBe(1);
  });
});
