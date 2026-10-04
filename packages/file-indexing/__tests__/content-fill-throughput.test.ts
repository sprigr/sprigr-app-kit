/**
 * sprigr-apps#2725: the content-fill drain's throughput. 0.1.2 filled one row
 * at a time inside a 15 s slice that a busy walk could take entirely, so a
 * 300-file Dropbox burst filled about 13 files per 15-minute tick and its text
 * arrived over four hours.
 *
 * These tests run on virtual time: every source call sleeps on a clock that
 * only moves when every row in flight is waiting, so rows that run
 * concurrently overlap the way they do against a real provider. A row costs
 * 1.1 s, measured on staging (round 6): a 300 ms re-read, a 300 ms permission
 * read and a 500 ms download.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_FILL_BUDGET_MS,
  CONTENT_FILL_CONCURRENCY,
  IDLE_CONTENT_FILL_BUDGET_MS,
  MAX_CONTENT_FILLS_PER_PASS,
  contentFillToken,
  countPendingContentFills,
  drainContentFills,
} from '../src/content-fill';
import { buildContext, indexActorFiles, type IndexActorFilesBudget } from '../src/indexer';
import type { FileIndexingLogEntry, FileIndexingStore, FileSourceAdapter, IndexedFileObject } from '../src/types';
import type { FakeFile } from './helpers/fake-source';
import { rig, type Rig } from './helpers/setup';

const K = 'u:user_alice';
const dbx = (id: string) => `dbx:file:${K}:${id}`;
const WALK_KEY = `dbx-acct-1/${K}`;
const TICK_MS = 60_000;
const TICK_INTERVAL_MS = 15 * 60_000;

/** A clock that moves only when every pending task is asleep. */
class VirtualTime {
  t = 1_000_000;
  private timers: Array<{ at: number; seq: number; wake: () => void }> = [];
  private seq = 0;
  now = (): number => this.t;
  sleep(ms: number): Promise<void> {
    return new Promise((wake) => this.timers.push({ at: this.t + ms, seq: this.seq++, wake }));
  }
  advance(ms: number): void {
    this.t += ms;
  }
  /** Settle `p`, moving the clock to the next timer whenever nothing else can run. */
  async run<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let guard = 0; guard < 1_000_000; guard++) {
      // sql.js answers synchronously behind a promise: a macrotask turn lets
      // every microtask chain run to its next sleep.
      await new Promise<void>((r) => setImmediate(r));
      if (settled) return p;
      if (this.timers.length === 0) {
        await new Promise<void>((r) => setImmediate(r));
        if (settled) return p;
        throw new Error('virtual time stalled: nothing is asleep and the task has not settled');
      }
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const at = this.timers[0]!.at;
      this.t = Math.max(this.t, at);
      const due = this.timers.filter((x) => x.at <= this.t);
      this.timers = this.timers.filter((x) => x.at > this.t);
      for (const d of due) d.wake();
    }
    throw new Error('virtual time: too many steps');
  }
}

interface Probe {
  inFlight: number;
  peak: number;
  /** Virtual time each row's re-read started (one per drained row). */
  rowStarts: number[];
  downloads: number;
  permissionReads: number;
}

interface Latency {
  refetchMs: number;
  permsMs: number;
  downloadMs: number;
}

const STAGING_ROW: Latency = { refetchMs: 300, permsMs: 300, downloadMs: 500 };

/** The Dropbox fake with refetchEntry, every source call sleeping on `vt`. */
function timedAdapter(
  r: Rig,
  vt: VirtualTime,
  probe: Probe,
  lat: Latency = STAGING_ROW,
  hooks: { download?: (o: IndexedFileObject, n: number) => { text: string; throttled: true } | null; refetch?: (o: IndexedFileObject) => void } = {},
): FileSourceAdapter<FakeFile> {
  const base = r.adapter;
  return {
    ...base,
    async refetchEntry(o) {
      probe.rowStarts.push(vt.now());
      probe.inFlight++;
      probe.peak = Math.max(probe.peak, probe.inFlight);
      try {
        await vt.sleep(lat.refetchMs);
        hooks.refetch?.(o);
        return r.src.files.get(String(o.fileId)) ?? null;
      } finally {
        probe.inFlight--;
      }
    },
    async resolvePrincipals(entries, ctx) {
      probe.permissionReads++;
      if (entries.length > 0) await vt.sleep(lat.permsMs);
      return base.resolvePrincipals(entries, ctx);
    },
    async downloadText(o, ctx) {
      const n = ++probe.downloads;
      probe.inFlight++;
      probe.peak = Math.max(probe.peak, probe.inFlight);
      try {
        await vt.sleep(lat.downloadMs);
        const forced = hooks.download?.(o, n);
        if (forced) return forced;
        return base.downloadText!(o, ctx);
      } finally {
        probe.inFlight--;
      }
    },
  };
}

const newProbe = (): Probe => ({ inFlight: 0, peak: 0, rowStarts: [], downloads: 0, permissionReads: 0 });

function seedBurst(r: Rig, n: number, from = 1): void {
  for (let i = from; i < from + n; i++) {
    const id = `b${String(i).padStart(3, '0')}`;
    r.src.put({ id, name: `bulk-${i}.txt`, mime: 'text/plain', content: `Bulk test file ${i}`, perms: [] });
  }
}

/** Queue `n` files for a content fill the way a webhook pass does when its
 *  source throttles: imported metadata-only, recorded, cursor moved. */
async function queueBurst(r: Rig, n: number): Promise<void> {
  r.src.pageSize = 1_000;
  seedBurst(r, n);
  const limited: FileSourceAdapter<FakeFile> = { ...r.adapter, downloadText: async () => ({ text: '', throttled: true }) };
  const out = await indexActorFiles(limited, r.store, r.fp.env, r.scope, { contentFillBudgetMs: 0 });
  expect(out).toMatchObject({ indexed: n, contentDeferred: n, contentPending: n });
}

/** Counts the store's pending-table writes. */
function countingStore(store: FileIndexingStore) {
  const writes = { bumps: 0, singleDeletes: 0, batchDeletes: 0, batchDeleted: 0, upserts: 0 };
  const wrapped: FileIndexingStore = {
    ...store,
    async bumpPendingExtraction(id) {
      writes.bumps++;
      return store.bumpPendingExtraction(id);
    },
    async deletePendingExtraction(id) {
      writes.singleDeletes++;
      return store.deletePendingExtraction(id);
    },
    async deletePendingExtractions(ids) {
      writes.batchDeletes++;
      writes.batchDeleted += ids.length;
      return store.deletePendingExtractions(ids);
    },
    async upsertPendingExtraction(row) {
      writes.upserts++;
      return store.upsertPendingExtraction(row);
    },
  };
  return { store: wrapped, writes };
}

const withText = (r: Rig) => [...r.fp.acl.values()].filter((o) => typeof o.content === 'string' && o.content.length > 0).length;

async function scheduledTick(r: Rig, vt: VirtualTime, adapter: FileSourceAdapter<FakeFile>, store: FileIndexingStore, extra: IndexActorFilesBudget = {}) {
  const start = vt.now();
  const out = await vt.run(
    indexActorFiles(adapter, store, r.fp.env, r.scope, { deadline: { at: start + TICK_MS }, now: vt.now, ...extra }),
  );
  return { out, start, end: vt.now() };
}

describe('sprigr-apps#2725: a 300-file burst drains in two scheduled ticks', () => {
  it('fills 300 queued rows in 2 ticks at 4 in flight, inside the slice, with batched writes', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 300);
    const vt = new VirtualTime();
    const probe = newProbe();
    const { store, writes } = countingStore(r.store);
    const adapter = timedAdapter(r, vt, probe);
    const importsBefore = r.fp.imports.length;

    const pending: number[] = [];
    const filled: number[] = [];
    for (let tick = 0; tick < 5; tick++) {
      const before = probe.rowStarts.length;
      const { out, start, end } = await scheduledTick(r, vt, adapter, store);
      pending.push(out.contentPending ?? -1);
      filled.push(out.contentFilled ?? 0);
      // No row starts with less than 1 s of the idle slice left, and the pass
      // ends within one row's 1.1 s of the slice.
      const starts = probe.rowStarts.slice(before);
      for (const s of starts) expect(s - start).toBeLessThanOrEqual(IDLE_CONTENT_FILL_BUDGET_MS - 1_000);
      expect(end - start).toBeLessThanOrEqual(IDLE_CONTENT_FILL_BUDGET_MS + 1_100);
      expect(end - start).toBeLessThanOrEqual(TICK_MS);
      if (out.contentPending === 0) break;
      vt.advance(TICK_INTERVAL_MS);
    }

    // A row starts while 1 s of the 45 s idle slice is left: at 0, 1.1 s, ...,
    // 44 s, so 41 rows per worker and 164 per tick at 4 in flight.
    expect(filled).toEqual([164, 136]);
    expect(pending).toEqual([136, 0]);
    expect(withText(r)).toBe(300);
    expect(r.fp.acl.get(dbx('b173'))!.content).toBe('Bulk test file 173');
    expect(probe.peak).toBe(CONTENT_FILL_CONCURRENCY);
    // D1: no per-row write beyond 0.1.2's (a batched delete per import chunk).
    expect(writes).toMatchObject({ bumps: 0, singleDeletes: 0, upserts: 0, batchDeleted: 300 });
    // One data.import per chunk of at most 100 rows: 100+64, then 100+36.
    const fillImports = r.fp.imports.slice(importsBefore).map((b) => b.length);
    expect(fillImports).toEqual([100, 64, 100, 36]);
    expect(writes.batchDeletes).toBe(fillImports.length);
  });

  it('the same harness at 0.1.2 settings (one row at a time, 15 s) fills 14 per tick', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 300);
    const vt = new VirtualTime();
    const probe = newProbe();
    const adapter = timedAdapter(r, vt, probe);
    const legacy: IndexActorFilesBudget = { contentFillConcurrency: 1, idleContentFillBudgetMs: CONTENT_FILL_BUDGET_MS, maxContentFills: 100 };
    const { out } = await scheduledTick(r, vt, adapter, r.store, legacy);
    // Round 6 measured 13 per tick on staging; 14 s / 1.1 s = 13, +1 at the edge.
    expect(out).toMatchObject({ contentFilled: 13, contentPending: 287 });
    expect(probe.peak).toBe(1);
  });

  it('a busy walk no longer starves the backlog: the walk stops its fetches early and the drain keeps its slice', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 91);
    const vt = new VirtualTime();
    const probe = newProbe();
    const adapter = timedAdapter(r, vt, probe);
    // The second batch of a burst arrives: 200 new files for the walk.
    seedBurst(r, 200, 101);
    const { out, start, end } = await scheduledTick(r, vt, adapter, r.store);
    expect(out.indexed).toBe(200);
    expect(out.error).toBeUndefined();
    // The walk downloaded until 15 s before the deadline (one at a time,
    // 500 ms each, after a 300 ms permission read), and queued the rest.
    // 300 ms permission read, then 90 downloads of 500 ms before 45 s.
    expect(out.contentDeferred).toBe(110);
    // The drain filled from the OLD backlog in its 15 s (0.1.2 filled none).
    expect(out.contentFilled).toBe(52);
    const oldFilled = [...Array(91).keys()].filter((i) => {
      const o = r.fp.acl.get(dbx(`b${String(i + 1).padStart(3, '0')}`));
      return typeof o?.content === 'string' && o.content.length > 0;
    }).length;
    expect(oldFilled).toBe(52);
    expect(end - start).toBeLessThanOrEqual(TICK_MS + 1_100);
    // Every file is either searchable by text or still queued: nothing lost.
    expect(withText(r) + (out.contentPending ?? 0)).toBe(291);

    expect(out.contentPending).toBe(149);

    // The next tick has no walk work: the idle slice finishes the burst.
    vt.advance(TICK_INTERVAL_MS);
    const next = await scheduledTick(r, vt, adapter, r.store);
    expect(next.out).toMatchObject({ contentFilled: 149, contentPending: 0 });
    expect(withText(r)).toBe(291);
  });
});

describe('sprigr-apps#2725: back-off, exactness and bounds with rows in flight', () => {
  it('a 429 stops new rows on its key; rows already in flight finish; nothing spends an attempt', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 120);
    const vt = new VirtualTime();
    const probe = newProbe();
    const { store, writes } = countingStore(r.store);
    // The 41st download answers 429.
    const adapter = timedAdapter(r, vt, probe, STAGING_ROW, {
      download: (_o, n) => (n === 41 ? { text: '', throttled: true } : null),
    });
    const { out, start } = await scheduledTick(r, vt, adapter, store);
    // 40 filled before the 429, plus the rows that were already in flight
    // when it answered (at most 3 others); no row starts after it.
    // Downloads 41 to 44 run together; 41 answers 429, 42 to 44 finish.
    expect(out.contentFilled).toBe(43);
    const throttledAt = start + Math.ceil(41 / CONTENT_FILL_CONCURRENCY) * 1_100;
    expect(probe.rowStarts.filter((s) => s > throttledAt)).toEqual([]);
    expect(writes.bumps).toBe(0);
    const rows = await r.store.listPendingContentFills!(contentFillToken(WALK_KEY), 500);
    expect(rows.every((x) => x.attempts === 0)).toBe(true);
    // Slower than the unthrottled 160, and the rest wait for the next tick.
    expect(out.contentPending).toBe(120 - out.contentFilled!);

    vt.advance(TICK_INTERVAL_MS);
    const fine = timedAdapter(r, vt, probe);
    const next = await scheduledTick(r, vt, fine, r.store);
    expect(next.out.contentPending).toBe(0);
  });

  it('a 429 on the re-read backs off too, without spending an attempt', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 20);
    const vt = new VirtualTime();
    const probe = newProbe();
    let reads = 0;
    const adapter: FileSourceAdapter<FakeFile> = {
      ...timedAdapter(r, vt, probe),
      async refetchEntry(o) {
        const n = ++reads;
        await vt.sleep(300);
        if (n === 6) throw Object.assign(new Error('too_many_requests'), { status: 429 });
        return r.src.files.get(String(o.fileId)) ?? null;
      },
    };
    const { out } = await scheduledTick(r, vt, adapter, r.store);
    // Re-reads 5 to 8 ran together; 6 answered 429. 5, 7 and 8 see the
    // throttle before their download and wait too. Only the first four fill.
    expect(reads).toBe(8);
    expect(out.contentFilled).toBe(4);
    const rows = await r.store.listPendingContentFills!(contentFillToken(WALK_KEY), 50);
    expect(rows.length).toBe(20 - out.contentFilled!);
    expect(rows.every((x) => x.attempts === 0)).toBe(true);
  });

  it('re-reads permissions per row: current principals, a failed read waits, a vanished file is dropped', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 12);
    // After queueing: b002 shared with bob, b003 unshared from nobody but its
    // permission read fails, b004 deleted, b005 moved into a shared folder.
    r.src.files.get('b002')!.perms = ['bob@corp.com'];
    r.src.failPerms.add('b003');
    r.src.files.delete('b004');
    r.src.sharedFolders.set('sf-1', ['carol@corp.com']);
    r.src.files.get('b005')!.sharedFolderId = 'sf-1';
    const vt = new VirtualTime();
    const probe = newProbe();
    const adapter = timedAdapter(r, vt, probe);
    const { out } = await scheduledTick(r, vt, adapter, r.store);
    expect(out).toMatchObject({ contentFilled: 10, contentPending: 1 });
    // One permission read per drained row (12 rows, 11 that still exist).
    expect(probe.permissionReads).toBe(11);
    expect(r.fp.acl.get(dbx('b002'))).toMatchObject({
      content: 'Bulk test file 2',
      acl_principals: ['user:alice@corp.com', 'user:bob@corp.com'],
    });
    expect(r.fp.acl.get(dbx('b005'))!.acl_principals).toEqual(['user:alice@corp.com', 'user:carol@corp.com']);
    // b003: never imported on a guess; queued with one attempt spent.
    expect(r.fp.acl.get(dbx('b003'))!.content).toBe('');
    const [b003] = await r.store.listPendingContentFills!(contentFillToken(WALK_KEY), 10);
    expect(b003).toMatchObject({ object_id: dbx('b003'), attempts: 1 });
    // b004: its fill is gone (the walk's deletion removes the row itself).
    expect((await r.store.listPendingExtractionsFor([dbx('b004')])).length).toBe(0);
  });

  it('never overwrites a row that is not a fill: a platform job queued meanwhile is left alone', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 8);
    // An extraction job claims b007 (a webhook pass handed it to the bridge).
    await r.store.upsertPendingExtraction({
      objectId: dbx('b007'),
      jobToken: 'dbxw-job-7',
      recordJson: JSON.stringify(r.fp.acl.get(dbx('b007'))),
      format: 'text/plain',
    });
    const vt = new VirtualTime();
    const adapter = timedAdapter(r, vt, newProbe());
    const { out } = await scheduledTick(r, vt, adapter, r.store);
    expect(out).toMatchObject({ contentFilled: 7, contentPending: 0 });
    const [job] = await r.store.listPendingExtractionsFor([dbx('b007')]);
    expect(job).toMatchObject({ job_token: 'dbxw-job-7' });
  });

  it('no row starts past the slice or the pass deadline, whichever is first', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 300);
    const row = (await r.store.load(r.scope))!;
    const ctxFor = (vt: VirtualTime, deadlineMs?: number) =>
      buildContext(r.fp.env, r.store, r.scope, row, { now: vt.now, ...(deadlineMs ? { deadline: { at: vt.now() + deadlineMs } } : {}) });
    for (const [sliceMs, deadlineMs] of [
      [15_000, undefined],
      [15_000, 6_000],
      [45_000, 20_000],
    ] as const) {
      const vt = new VirtualTime();
      const probe = newProbe();
      const adapter = timedAdapter(r, vt, probe);
      const start = vt.now();
      const ctx = ctxFor(vt, deadlineMs);
      const out = await vt.run(drainContentFills(adapter, r.store, ctx, { budgetMs: sliceMs, ...(ctx.deadline ? { deadline: ctx.deadline } : {}) }));
      const bound = Math.min(sliceMs, deadlineMs ?? Infinity);
      for (const s of probe.rowStarts) expect(s - start).toBeLessThanOrEqual(bound - 1_000);
      expect(vt.now() - start).toBeLessThanOrEqual(bound + 1_100);
      expect(probe.peak).toBeLessThanOrEqual(CONTENT_FILL_CONCURRENCY);
      expect(out.considered).toBe(MAX_CONTENT_FILLS_PER_PASS);
      expect(out.filled + out.deferred).toBe(out.considered);
      expect(out.filled).toBe(Math.floor((bound - 1_000) / 1_100 + 1) * CONTENT_FILL_CONCURRENCY);
    }
  });

  it('a pass with the drain off keeps 0.1.2 behaviour: no backlog read, no early stop for the walk', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 30);
    seedBurst(r, 10, 101);
    const vt = new VirtualTime();
    const probe = newProbe();
    let counts = 0;
    const store: FileIndexingStore = {
      ...r.store,
      async countPendingContentFills(token) {
        counts++;
        return r.store.countPendingContentFills!(token);
      },
    };
    const start = vt.now();
    const out = await vt.run(
      indexActorFiles(timedAdapter(r, vt, probe), store, r.fp.env, r.scope, {
        deadline: { at: start + 15_000 },
        now: vt.now,
        contentFillBudgetMs: 0,
      }),
    );
    // The walk fetched all 10 new files in sequence (5 s); the drain did not run.
    expect(out).toMatchObject({ indexed: 10, contentPending: 30 });
    expect(out.contentFilled).toBeUndefined();
    expect(out.contentDeferred).toBeUndefined();
    expect(probe.rowStarts).toEqual([]);
    expect(probe.peak).toBe(1);
    // Only the end-of-pass count that reports contentPending.
    expect(counts).toBe(1);
  });

  it('a pass with no deadline keeps the 15 s slice: the idle slice needs a deadline to bound it', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 300);
    const vt = new VirtualTime();
    const probe = newProbe();
    const start = vt.now();
    const out = await vt.run(indexActorFiles(timedAdapter(r, vt, probe), r.store, r.fp.env, r.scope, { now: vt.now }));
    expect(vt.now() - start).toBeLessThanOrEqual(CONTENT_FILL_BUDGET_MS + 1_100);
    expect(out.contentFilled).toBe(52);
  });

  it('logs each drain through env.SPRIGR.log (Analytics Engine, not D1)', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 30);
    const logs: FileIndexingLogEntry[] = [];
    r.fp.env.SPRIGR!.log = async (entry) => {
      logs.push(entry);
      return { ok: true, written: 1 };
    };
    const vt = new VirtualTime();
    const { out } = await scheduledTick(r, vt, timedAdapter(r, vt, newProbe()), r.store);
    expect(out).toMatchObject({ contentFilled: 30, contentPending: 0 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 'info',
      category: 'file_indexing.content_fill',
      metadata: { walk_key: WALK_KEY, filled: 30, pending: 0, pending_before: 30, idle: true, peak_in_flight: 4 },
    });
    expect(await countPendingContentFills(r.store, r.scope)).toBe(0);
  });

  it('a logger that throws never fails the pass', async () => {
    const r = await rig('dropbox');
    await queueBurst(r, 5);
    r.fp.env.SPRIGR!.log = () => {
      throw new Error('summary_too_long');
    };
    const vt = new VirtualTime();
    const { out } = await scheduledTick(r, vt, timedAdapter(r, vt, newProbe()), r.store);
    expect(out).toMatchObject({ contentFilled: 5, contentPending: 0 });
    expect(out.error).toBeUndefined();
  });
});
