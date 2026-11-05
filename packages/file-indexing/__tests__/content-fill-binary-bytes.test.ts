/**
 * sprigr-team#13478: an idle drain runs more binaries at once, so it caps the
 * bytes in flight and does not start a binary it cannot finish before the
 * pass deadline. A binary without a content-length is buffered whole in the
 * isolate, and LSR's pending PDFs run to 16 MB (p99 7.9 MB, 2026-11-05).
 */
import { describe, expect, it } from 'vitest';
import { MAX_EXTRACTIONS_PER_RUN } from '../src/content';
import {
  DEFAULT_FILL_BINARY_START_RESERVE_MS,
  MAX_BINARY_BYTES_IN_FLIGHT,
  contentFillToken,
  drainContentFills,
} from '../src/content-fill';
import { buildContext, indexActorFiles } from '../src/indexer';
import type { FileSourceAdapter, IndexedFileObject } from '../src/types';
import type { FakeFile } from './helpers/fake-source';
import { clock, rig, type Rig } from './helpers/setup';
import { VirtualTime } from './helpers/virtual-time';

const PDF = 'application/pdf';
const MB = 1024 * 1024;

function seedPdfs(r: Rig, n: number, size: number): void {
  r.src.pageSize = 1_000;
  for (let i = 0; i < n; i++) {
    const id = `p${String(i).padStart(3, '0')}`;
    r.src.put({ id, name: `${id}.pdf`, mime: PDF, size, perms: [] });
    r.src.binary.set(id, new TextEncoder().encode(`text ${id}`));
  }
}

/** Downloads that stay open for a few macrotask turns, tracking the stated
 *  bytes of every binary in flight. */
function tracked(r: Rig): { adapter: FileSourceAdapter<FakeFile>; peakBytes: () => number; downloads: () => number } {
  let inFlight = 0;
  let peak = 0;
  let n = 0;
  return {
    adapter: {
      ...r.adapter,
      async downloadBinary(o: IndexedFileObject, ctx) {
        n++;
        const size = typeof o.size === 'number' ? o.size : 0;
        inFlight += size;
        peak = Math.max(peak, inFlight);
        try {
          for (let i = 0; i < 3; i++) await new Promise<void>((done) => setImmediate(done));
          return r.adapter.downloadBinary!(o, ctx);
        } finally {
          inFlight -= size;
        }
      },
    },
    peakBytes: () => peak,
    downloads: () => n,
  };
}

/** One walk spends the pass's binary cap; the rest wait for a drain. */
async function queue(r: Rig, c: ReturnType<typeof clock>, n: number, size: number): Promise<void> {
  seedPdfs(r, MAX_EXTRACTIONS_PER_RUN + n, size);
  const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { contentFillBudgetMs: 0, now: c.now });
  expect(out).toMatchObject({ contentPending: n });
}

async function ctxFor(r: Rig, c: ReturnType<typeof clock>, deadlineMs?: number) {
  const row = (await r.store.load(r.scope))!;
  return buildContext(r.fp.env, r.store, r.scope, row, {
    now: c.now,
    ...(deadlineMs !== undefined ? { deadline: { at: c.now() + deadlineMs } } : {}),
  });
}

describe('sprigr-team#13478: binary bytes in flight and the start reserve', () => {
  it('holds back a large binary the slot count would allow once the bytes in flight would pass the cap', async () => {
    const r = await rig('dropbox');
    const c = clock();
    const size = 15 * MB;
    await queue(r, c, 4, size);
    const { adapter, peakBytes } = tracked(r);
    const ctx = await ctxFor(r, c);
    const out = await drainContentFills(adapter, r.store, ctx, { concurrency: 4, maxBinaries: 16, budget: { extracted: 0, deferred: 0 } });

    const fit = Math.floor(MAX_BINARY_BYTES_IN_FLIGHT / size);
    expect(fit).toBe(3);
    expect(peakBytes()).toBeLessThanOrEqual(MAX_BINARY_BYTES_IN_FLIGHT);
    expect(peakBytes()).toBe(fit * size);
    // Four slots, three fit: the fourth waits without spending an attempt.
    expect(out).toMatchObject({ considered: 4, filled: fit, waiting: 1, dropped: 0 });
    const left = await r.store.listPendingContentFills!(contentFillToken(ctx.walkKey!), 100);
    expect(left.map((row) => row.attempts)).toEqual([0]);
  });

  it('starts a binary larger than the cap when nothing else is in flight', async () => {
    const r = await rig('dropbox');
    const c = clock();
    await queue(r, c, 1, 15 * MB);
    const { adapter, downloads } = tracked(r);
    const ctx = await ctxFor(r, c);
    const out = await drainContentFills(adapter, r.store, ctx, {
      concurrency: 4,
      maxBinaries: 16,
      maxBinaryBytesInFlight: 10 * MB,
      budget: { extracted: 0, deferred: 0 },
    });
    expect(out).toMatchObject({ filled: 1, waiting: 0 });
    expect(downloads()).toBe(1);
  });

  it('does not start a binary whose start reserve is more than the time left before the deadline', async () => {
    const r = await rig('dropbox');
    const c = clock();
    await queue(r, c, 2, 1 * MB);
    const { adapter, downloads } = tracked(r);
    const leftMs = DEFAULT_FILL_BINARY_START_RESERVE_MS - 2_000;
    const ctx = await ctxFor(r, c, leftMs);
    const out = await drainContentFills(adapter, r.store, ctx, {
      deadline: ctx.deadline!,
      budgetMs: 45_000,
      maxBinaries: 16,
      budget: { extracted: 0, deferred: 0 },
    });
    expect(out).toMatchObject({ considered: 2, filled: 0, waiting: 2, dropped: 0 });
    expect(downloads()).toBe(0);
    expect(r.fp.extractCalls).toHaveLength(MAX_EXTRACTIONS_PER_RUN);

    // A caller's own, smaller reserve still wins over the default.
    const own = await drainContentFills(adapter, r.store, ctx, {
      deadline: ctx.deadline!,
      budgetMs: 45_000,
      maxBinaries: 16,
      binaryStartReserveMs: leftMs - 2_000,
      budget: { extracted: 0, deferred: 0 },
    });
    expect(own).toMatchObject({ filled: 2, waiting: 0 });
  });

  it('the webhook pass keeps its explicit 5 s walk reserve, and the default reserve stays off the walk', async () => {
    const WEBHOOK_RESERVE_MS = 5_000;
    for (const reserve of [WEBHOOK_RESERVE_MS, undefined]) {
      const r = await rig('dropbox');
      const c = clock();
      seedPdfs(r, 1, 1 * MB);
      const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, {
        deadline: { at: c.now() + 8_000 },
        now: c.now,
        contentFillBudgetMs: 0,
        ...(reserve !== undefined ? { binaryStartReserveMs: reserve } : {}),
      });
      // 8 s left: more than the webhook's 5 s, less than the drain default.
      expect(8_000).toBeLessThan(DEFAULT_FILL_BINARY_START_RESERVE_MS);
      expect(out).toMatchObject({ indexed: 1, contentPending: 0 });
      expect(r.fp.extractCalls).toHaveLength(1);
    }
    const r = await rig('dropbox');
    const c = clock();
    seedPdfs(r, 1, 1 * MB);
    const tight = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, {
      deadline: { at: c.now() + WEBHOOK_RESERVE_MS - 1_000 },
      now: c.now,
      contentFillBudgetMs: 0,
      binaryStartReserveMs: WEBHOOK_RESERVE_MS,
    });
    expect(tight).toMatchObject({ contentPending: 1 });
    expect(r.fp.extractCalls).toHaveLength(0);
  });
});

describe('sprigr-team#13478: two scopes in one tick', () => {
  const ROW_MS = 10_000;
  const LIST_MS = 5_000;
  const TICK_MS = 60_000;

  /** A Dropbox scope with a binary backlog: each walk's list call takes
   *  LIST_MS and each download ROW_MS. */
  async function slowScope(vt: VirtualTime): Promise<{ r: Rig; adapter: FileSourceAdapter<FakeFile>; downloads: () => number }> {
    const r = await rig('dropbox');
    seedPdfs(r, MAX_EXTRACTIONS_PER_RUN + 64, 1 * MB);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { contentFillBudgetMs: 0, now: vt.now });
    let n = 0;
    const adapter: FileSourceAdapter<FakeFile> = {
      ...r.adapter,
      async listChanges(c, ctx) {
        await vt.sleep(LIST_MS);
        return r.adapter.listChanges(c, ctx);
      },
      async downloadBinary(o, ctx) {
        n++;
        await vt.sleep(ROW_MS);
        return r.adapter.downloadBinary!(o, ctx);
      },
    };
    return { r, adapter, downloads: () => n };
  }

  // LSR (2026-11-05): the scope that ran first spent the tick's 45 s idle
  // slice, and the second drained 0 files with 16 waiting.
  it('the scope that runs second still starts and lands fills', async () => {
    const vt = new VirtualTime();
    const scopes = [await slowScope(vt), await slowScope(vt)];
    const deadline = { at: vt.now() + TICK_MS };
    const outs = [];
    for (const [i, s] of scopes.entries()) {
      outs.push(
        await vt.run(
          indexActorFiles(s.adapter, s.r.store, s.r.fp.env, s.r.scope, {
            deadline,
            now: vt.now,
            idleContentFillMaxBinaries: 64,
            contentFillScopesLeft: scopes.length - i,
          }),
        ),
      );
    }
    for (const [i, s] of scopes.entries()) {
      expect(s.downloads(), `scope ${i} downloads`).toBeGreaterThan(0);
      expect(outs[i]!.contentFilled ?? 0, `scope ${i} filled`).toBeGreaterThan(0);
    }
    expect(vt.now()).toBeLessThanOrEqual(deadline.at);
  });
});
