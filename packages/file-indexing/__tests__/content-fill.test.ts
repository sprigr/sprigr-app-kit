/**
 * sprigr-apps#2702: files a pass imports without their text are queued and
 * filled by later passes, instead of staying searchable by name only until
 * they next change.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_FILL_TOKEN_PREFIX,
  MAX_CONTENT_FILL_ATTEMPTS,
  contentFillToken,
  countPendingContentFills,
  describeContentPending,
  recordContentFills,
} from '../src/content-fill';
import { indexActorFiles, purgeActor, refreshAclPrincipals } from '../src/indexer';
import { drainPendingExtractions } from '../src/pending';
import type { FileIndexingStore, FileSourceAdapter } from '../src/types';
import type { FakeFile } from './helpers/fake-source';
import { clock, rig, seedFiles, type Rig } from './helpers/setup';

const K = 'u:user_alice';
const dbx = (id: string) => `dbx:file:${K}:${id}`;
const PDF = 'application/pdf';

/** Each text download takes `ms` on the test clock. */
function slowText(r: Rig, c: ReturnType<typeof clock>, ms: number): FileSourceAdapter<FakeFile> {
  return {
    ...r.adapter,
    async downloadText(o, ctx) {
      c.advance(ms);
      return r.adapter.downloadText!(o, ctx);
    },
  };
}

function seedBurst(r: Rig, n: number): void {
  for (let i = 1; i <= n; i++) {
    const id = `b${String(i).padStart(3, '0')}`;
    r.src.put({ id, name: `bulk-${i}.txt`, mime: 'text/plain', content: `Bulk test file ${i}`, perms: [] });
  }
}

const tick = (r: Rig, adapter: FileSourceAdapter<FakeFile>, c: ReturnType<typeof clock>, ms = 5_000) =>
  indexActorFiles(adapter, r.store, r.fp.env, r.scope, { deadline: { at: c.now() + ms }, now: c.now });

describe('a burst larger than one pass can fetch', () => {
  it('queues the rest, moves the cursor anyway, and fills every file over the next passes', async () => {
    const r = await rig('dropbox');
    const c = clock();
    r.src.pageSize = 100;
    seedBurst(r, 60);
    const adapter = slowText(r, c, 250);

    const first = await tick(r, adapter, c);
    // 5 s at 250 ms a download: 20 got their text inside the walk.
    expect(first.indexed).toBe(60);
    expect(first.contentDeferred).toBe(40);
    expect(first.contentPending).toBe(40);
    expect(first.error).toBeUndefined();
    // Cursor semantics unchanged: the walk completed and holds its baseline.
    const row = (await r.store.load(r.scope))!;
    expect(row.cursor).toBe('dbx:chg:60');
    expect(row.full_walk_active).toBe(0);
    const withText = () => [...r.fp.acl.values()].filter((o) => typeof o.content === 'string' && o.content.length > 0).length;
    expect(withText()).toBe(20);
    expect(await countPendingContentFills(r.store, r.scope)).toBe(40);
    // Not platform jobs: the extraction drain never sees them.
    expect(await r.store.listPendingExtractions(10)).toEqual([]);

    const pending: number[] = [];
    for (let i = 0; i < 6; i++) {
      const out = await tick(r, adapter, c);
      pending.push(out.contentPending ?? -1);
      if (out.contentPending === 0) break;
    }
    // Each later pass starts a row while at least 1 s of its 5 s is left: 17 per pass.
    expect(pending).toEqual([23, 6, 0]);
    expect(withText()).toBe(60);
    expect(r.fp.acl.get(dbx('b047'))!.content).toBe('Bulk test file 47');
    expect(await countPendingContentFills(r.store, r.scope)).toBe(0);
  });

  it('does not drain when the pass turns the slice off, and never runs past the pass deadline', async () => {
    const r = await rig('dropbox');
    const c = clock();
    r.src.pageSize = 100;
    seedBurst(r, 10);
    const adapter = slowText(r, c, 1_000);
    const first = await tick(r, adapter, c, 3_000);
    expect(first.contentPending).toBe(7);
    const off = await indexActorFiles(adapter, r.store, r.fp.env, r.scope, {
      deadline: { at: c.now() + 60_000 },
      now: c.now,
      contentFillBudgetMs: 0,
    });
    expect(off).toMatchObject({ contentPending: 7 });
    expect(off.contentFilled).toBeUndefined();
    const start = c.now();
    const on = await tick(r, adapter, c, 4_000);
    // A row starts only with at least 1 s left: four 1 s downloads, then it stops.
    expect(on).toMatchObject({ contentFilled: 4, contentPending: 3 });
    expect(c.now() - start).toBeLessThanOrEqual(4_000);
  });
});

describe('what the backlog does when files change', () => {
  it('refills a file that changed mid-backlog from its new revision', async () => {
    const r = await rig('dropbox');
    const c = clock();
    r.src.pageSize = 100;
    seedBurst(r, 4);
    const first = await tick(r, slowText(r, c, 2_000), c, 3_000);
    expect(first.contentPending).toBe(2);
    // b004 waits. It is edited, and the next pass's walk sees the edit but
    // runs out of time before fetching it: the queued record is refreshed.
    r.src.touch('b004', { content: 'The amber kingfisher contract renews in March.', modifiedAt: '2026-10-03T21:41:00Z' });
    const slowList: FileSourceAdapter<FakeFile> = {
      ...r.adapter,
      async listChanges(cursor, ctx) {
        const page = await r.adapter.listChanges(cursor, ctx);
        c.advance(10_000);
        return page;
      },
    };
    await tick(r, slowList, c);
    const [queued] = (await r.store.listPendingContentFills!(contentFillToken(`dbx-acct-1/${K}`), 10)).filter(
      (x) => x.object_id === dbx('b004'),
    );
    expect(JSON.parse(queued!.record_json).modifiedAt).toBe('2026-10-03T21:41:00Z');
    const done = await tick(r, r.adapter, c);
    expect(done.contentPending).toBe(0);
    expect(r.fp.acl.get(dbx('b004'))).toMatchObject({
      content: 'The amber kingfisher contract renews in March.',
      modifiedAt: '2026-10-03T21:41:00Z',
    });
  });

  it('with refetchEntry: re-reads the file, fills the new revision under its CURRENT principals', async () => {
    const r = await rig('dropbox');
    const c = clock();
    r.src.pageSize = 100;
    r.src.put({ id: 'x', name: 'x.txt', mime: 'text/plain', content: 'old', perms: ['bob@corp.com'] });
    const throttledOnce: FileSourceAdapter<FakeFile> = { ...r.adapter, downloadText: async () => ({ text: '', throttled: true }) };
    const first = await tick(r, throttledOnce, c);
    expect(first.contentPending).toBe(1);
    expect(r.fp.acl.get(dbx('x'))!.acl_principals).toContain('user:bob@corp.com');
    // Changed and unshared, and no walk has seen it yet (maxPages 0 below).
    const f = r.src.files.get('x')!;
    r.src.files.set('x', { ...f, content: 'new', perms: [], modifiedAt: '2026-10-04T00:00:00Z' });
    const refetching: FileSourceAdapter<FakeFile> = {
      ...r.adapter,
      async refetchEntry(o) {
        return r.src.files.get(String(o.fileId)) ?? null;
      },
    };
    const out = await indexActorFiles(refetching, r.store, r.fp.env, r.scope, { maxPages: 0 });
    expect(out).toMatchObject({ contentFilled: 1, contentPending: 0 });
    expect(r.fp.acl.get(dbx('x'))).toMatchObject({
      content: 'new',
      modifiedAt: '2026-10-04T00:00:00Z',
      acl_principals: ['user:alice@corp.com'],
    });
  });

  it('drops a deleted file: through the walk, through refetchEntry, and through a missing download', async () => {
    const r = await rig('dropbox');
    const c = clock();
    r.src.pageSize = 100;
    seedBurst(r, 6);
    await tick(r, slowText(r, c, 2_000), c, 3_000);
    expect(await countPendingContentFills(r.store, r.scope)).toBe(4);

    // The walk reports b003 deleted: its row and its fill both go.
    r.src.remove('b003');
    const walked = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { contentFillBudgetMs: 0 });
    expect(walked.contentPending).toBe(3);
    expect(r.fp.acl.has(dbx('b003'))).toBe(false);

    // refetchEntry says b004 is gone before any walk noticed.
    const gone: FileSourceAdapter<FakeFile> = {
      ...r.adapter,
      async refetchEntry(o) {
        return o.fileId === 'b004' ? null : (r.src.files.get(String(o.fileId)) ?? null);
      },
      async downloadText(o, ctx) {
        return o.fileId === 'b005' ? { text: '', missing: true } : r.adapter.downloadText!(o, ctx);
      },
    };
    const out = await indexActorFiles(gone, r.store, r.fp.env, r.scope, { maxPages: 0 });
    // b004 (vanished) and b005 (download says missing) dropped; b006 filled.
    expect(out).toMatchObject({ contentFilled: 1, contentPending: 0 });
    expect(r.fp.acl.get(dbx('b006'))!.content).toBe('Bulk test file 6');
    expect(r.fp.acl.get(dbx('b005'))!.content).toBe('');
  });

  it('retries a failing fetch, then gives up after MAX_CONTENT_FILL_ATTEMPTS', async () => {
    const r = await rig('dropbox');
    r.src.put({ id: 'x', name: 'x.txt', mime: 'text/plain', content: 'never', perms: [] });
    const failing: FileSourceAdapter<FakeFile> = {
      ...r.adapter,
      async downloadText() {
        throw new Error('503 from the source');
      },
    };
    const first = await indexActorFiles(failing, r.store, r.fp.env, r.scope, { contentFillBudgetMs: 0 });
    expect(first).toMatchObject({ contentDeferred: 1, contentPending: 1 });
    const seen: number[] = [];
    for (let i = 0; i < MAX_CONTENT_FILL_ATTEMPTS + 1; i++) {
      seen.push((await indexActorFiles(failing, r.store, r.fp.env, r.scope, { maxPages: 0 })).contentPending ?? -1);
    }
    expect(seen).toEqual([1, 1, 1, 1, 0, 0]);
  });
});

describe('the other deferrals a pass makes', () => {
  it('fills the binaries the per-pass extraction cap deferred', async () => {
    const r = await rig('drive');
    r.src.pageSize = 10;
    for (let i = 0; i < 7; i++) {
      r.src.put({ id: `p${i}`, name: `${i}.pdf`, mime: PDF, perms: [] });
      r.src.binary.set(`p${i}`, new TextEncoder().encode(`text ${i}`));
    }
    const first = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    // The drain at the end of the pass shares the cap, so it extracts nothing more.
    expect(r.fp.extractCalls).toHaveLength(5);
    expect(first).toMatchObject({ contentDeferred: 2, contentPending: 2 });
    const second = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(second).toMatchObject({ contentFilled: 2, contentPending: 0 });
    for (let i = 0; i < 7; i++) expect(r.fp.acl.get(`gw:file:p${i}`)!.content).toBe(`text ${i}`);
  });

  it('fills the files of a rate-limited drive on a later pass, without asking it again this pass', async () => {
    const r = await rig('drive');
    r.src.pageSize = 10;
    r.src.put({ id: 'a', name: 'a.txt', mime: 'text/plain', content: 'A', perms: [] });
    r.src.put({ id: 'b', name: 'b.txt', mime: 'text/plain', content: 'B', perms: [] });
    let asked = 0;
    const limited: FileSourceAdapter<FakeFile> = { ...r.adapter, downloadText: async () => (asked++, { text: '', throttled: true }) };
    const first = await indexActorFiles(limited, r.store, r.fp.env, r.scope);
    expect(asked).toBe(1);
    expect(first).toMatchObject({ contentDeferred: 2, contentPending: 2 });
    const second = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(second).toMatchObject({ contentFilled: 2, contentPending: 0 });
    expect(r.fp.acl.get('gw:file:a')!.content).toBe('A');
  });

  it('leaves a platform extraction job alone instead of overwriting it with a fill', async () => {
    const r = await rig('drive');
    r.src.put({ id: 's', name: 'deck.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', perms: [] });
    r.src.binary.set('s', new TextEncoder().encode('slides'));
    const adapter = { ...r.adapter, extractJobToken: async () => 'gwx-fixed' };
    await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    // A later walk sees the deck again and runs out of time before it.
    const c = clock();
    r.src.touch('s', {});
    const slowList: FileSourceAdapter<FakeFile> = {
      ...adapter,
      async listChanges(cursor, ctx) {
        const page = await adapter.listChanges(cursor, ctx);
        c.advance(10_000);
        return page;
      },
    };
    const out = await tick(r, slowList, c);
    expect(out.contentDeferred).toBeUndefined();
    const [row] = await r.store.listPendingExtractions(5);
    expect(row).toMatchObject({ object_id: 'gw:file:s', job_token: 'gwx-fixed' });
  });
});

describe('content_pending and the queue boundaries', () => {
  it('counts per scope, and describes the backlog in a sentence', async () => {
    const r = await rig('delta');
    r.src.pageSize = 10;
    seedFiles(r.src, 3);
    const failing: FileSourceAdapter<FakeFile> = {
      ...r.adapter,
      async downloadText() {
        throw new Error('boom');
      },
    };
    const out = await indexActorFiles(failing, r.store, r.fp.env, r.scope, { contentFillBudgetMs: 0 });
    expect(out.contentPending).toBe(3);
    const other = { actor: { platformUserId: 'user_bob' }, connectionId: 'conn-2' };
    await r.store.enable(other, { connectedEmail: 'bob@corp.com', extra: { tenant_id: 'tenant-1' } });
    expect(await countPendingContentFills(r.store, other)).toBe(0);
    expect(await countPendingContentFills(r.store, r.scope)).toBe(3);
    expect(describeContentPending(3)).toBe('3 files are searchable by name only until their text is processed.');
    expect(describeContentPending(1)).toBe('1 file is searchable by name only until its text is processed.');
    expect(describeContentPending(0)).toBeNull();
  });

  it('the extraction drain skips fill rows even when a store lists them', async () => {
    const r = await rig('drive');
    await r.store.upsertPendingExtraction({
      objectId: 'gw:file:t',
      jobToken: `${CONTENT_FILL_TOKEN_PREFIX}u:user_alice`,
      recordJson: JSON.stringify({ objectID: 'gw:file:t', acl_principals: ['user:a@b.c'] }),
      format: 'text/plain',
    });
    // A store with its own listing SQL (Dropbox's Riviera view does this).
    const leaky: FileIndexingStore = {
      ...r.store,
      async listPendingExtractions(limit) {
        return r.store.listPendingContentFills!(`${CONTENT_FILL_TOKEN_PREFIX}u:user_alice`, limit);
      },
    };
    expect(await drainPendingExtractions(leaky, r.fp.env)).toBe(0);
    expect(await countPendingContentFills(r.store, r.scope)).toBe(1);
  });

  it('re-recording the same deferred files writes nothing (a re-listed scope defers the same tail every pass)', async () => {
    const r = await rig('drive');
    let writes = 0;
    const counting: FileIndexingStore = {
      ...r.store,
      async upsertPendingContentFills(rows) {
        writes += rows.length;
        return r.store.upsertPendingContentFills!(rows);
      },
    };
    const items = [{ object: { objectID: 'gw:file:a', acl_principals: ['user:a@b.c'], content: '' }, mime: 'text/plain' }];
    const ctx = { walkKey: 'u:user_alice' };
    expect(await recordContentFills(counting, ctx, items)).toEqual({ recorded: 1 });
    expect(await recordContentFills(counting, ctx, items)).toEqual({ recorded: 1 });
    expect(writes).toBe(1);
    await recordContentFills(counting, ctx, [{ ...items[0]!, object: { ...items[0]!.object, name: 'renamed' } }]);
    expect(writes).toBe(2);
  });

  it('a pass that cannot record its fills keeps the cursor and says so', async () => {
    const r = await rig('dropbox');
    const c = clock();
    r.src.pageSize = 100;
    seedBurst(r, 3);
    const broken: FileIndexingStore = {
      ...r.store,
      async upsertPendingContentFills() {
        throw new Error('D1 overloaded');
      },
    };
    const out = await indexActorFiles(slowText(r, c, 2_000), broken, r.fp.env, r.scope, {
      deadline: { at: c.now() + 1_000 },
      now: c.now,
    });
    expect(out.error).toMatch(/^content_fill_record_failed: D1 overloaded/);
    expect((await r.store.load(r.scope))!.cursor).toBeNull();
    expect(r.fp.imports).toEqual([]);
  });

  it('the disconnect purge removes the scope fills, and a re-enable starts clean', async () => {
    const r = await rig('dropbox');
    seedFiles(r.src, 2);
    const failing: FileSourceAdapter<FakeFile> = {
      ...r.adapter,
      async downloadText() {
        throw new Error('boom');
      },
    };
    await indexActorFiles(failing, r.store, r.fp.env, r.scope, { contentFillBudgetMs: 0 });
    expect(await countPendingContentFills(r.store, r.scope)).toBe(2);
    await r.store.enable(r.scope, { connectedEmail: 'alice@corp.com' });
    expect(await countPendingContentFills(r.store, r.scope)).toBe(0);
    await indexActorFiles(failing, r.store, r.fp.env, r.scope, { contentFillBudgetMs: 0 });
    expect(await countPendingContentFills(r.store, r.scope)).toBe(2);
    const purge = await purgeActor(r.adapter, r.store, r.fp.env, r.scope);
    expect(purge.errors).toEqual([]);
    expect(await countPendingContentFills(r.store, r.scope)).toBe(0);
  });

  it('a permission re-stamp updates waiting records, so a fill never restores a removed principal', async () => {
    const r = await rig('delta');
    r.src.pageSize = 10;
    seedFiles(r.src, 2);
    const failing: FileSourceAdapter<FakeFile> = {
      ...r.adapter,
      async downloadText() {
        throw new Error('boom');
      },
    };
    await indexActorFiles(failing, r.store, r.fp.env, r.scope, { contentFillBudgetMs: 0 });
    const oid = `ms:file:${K}:drive-1:f01`;
    expect(r.fp.acl.get(oid)!.acl_principals).toContain('user:bob@corp.com');
    // Unshared with no change record; the daily re-stamp catches it.
    r.src.files.get('f01')!.perms = [];
    await refreshAclPrincipals(r.adapter, r.store, r.fp.env, r.scope, { now: () => 5_000 });
    expect(r.fp.acl.get(oid)!.acl_principals).toEqual(['user:alice@corp.com']);
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { maxPages: 0 });
    expect(out).toMatchObject({ contentFilled: 2, contentPending: 0 });
    expect(r.fp.acl.get(oid)).toMatchObject({ content: 'body 1', acl_principals: ['user:alice@corp.com'] });
  });
});
