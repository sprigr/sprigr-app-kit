/**
 * indexActorFiles over a microsoft-365-shaped adapter and the real
 * ms_file_indexing schema: one delta feed whose nextLink IS the stored cursor
 * during a full walk, permissions from a batch that can fail, per-connection
 * scope, SharePoint-style extra scopes, a lease, and a deletion latch.
 */
import { describe, expect, it } from 'vitest';
import { indexActorFiles } from '../src/indexer';
import type { ExtraScopesResult, FileIndexingScope } from '../src/types';
import type { FakeFile } from './helpers/fake-source';
import { ALICE, clock, rig, seedFiles } from './helpers/setup';

const K = 'u:user_alice';
const oid = (id: string, drive = 'drive-1') => `ms:file:${K}:${drive}:${id}`;

describe('microsoft-365 shape: full walk on the delta', () => {
  it('stores the nextLink as the cursor mid-walk, then the deltaLink, and reconciles per drive', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 3);
    r.fp.acl.set(oid('gone'), { objectID: oid('gone'), acl_principals: ['user:x@y.com'] });
    r.fp.acl.set(oid('lib-file', 'sp-lib'), { objectID: oid('lib-file', 'sp-lib'), acl_principals: ['user:x@y.com'] });
    r.fp.plain.set('ms:file:stray', { objectID: 'ms:file:stray' });

    const t1 = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { maxPages: 1 });
    expect(t1).toMatchObject({ indexed: 2, pagesWalked: 1 });
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: 'full:2', full_walk_active: 1 });

    const t2 = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(t2).toMatchObject({ indexed: 1, reconciled: 2 }); // one stale ACL row + one plain stray
    expect(r.fp.acl.has(oid('gone'))).toBe(false);
    expect(r.fp.acl.has(oid('lib-file', 'sp-lib'))).toBe(true); // other drive prefixes are never diffed
    expect(r.fp.plain.size).toBe(0);
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: 'delta:3', full_walk_active: 0 });
    expect(r.fp.emitted).toEqual([]);
  });

  it('skips the reconcile when another invocation moved the walk under this one', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 1);
    r.fp.acl.set(oid('gone'), { objectID: oid('gone'), acl_principals: ['user:x@y.com'] });
    const adapter = {
      ...r.adapter,
      fullWalk: async (t: string | null, ctx: Parameters<typeof r.adapter.fullWalk>[1]) => {
        const page = await r.adapter.fullWalk(t, ctx);
        // A racing pass finished the walk while this one was listing.
        await r.store.recordSuccess(r.scope, 'delta:99', 0, 0);
        return page;
      },
    };
    const out = await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(out.reconciled).toBeUndefined();
    expect(r.fp.acl.has(oid('gone'))).toBe(true);
  });

  it('keeps two connections of one person apart', async () => {
    const r = await rig('delta');
    const second: FileIndexingScope = { actor: ALICE, connectionId: 'conn-2' };
    await r.store.enable(second, { connectedEmail: 'alice@second.com' });
    seedFiles(r.src, 1);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect((await r.store.load(second))!.cursor).toBeNull();
    expect(r.store.walkKey(second)).not.toBe(r.store.walkKey(r.scope));
  });
});

describe('sprigr-apps#2419: unresolved permissions hold the cursor', () => {
  async function walked() {
    const r = await rig('delta', { heldSince: true });
    seedFiles(r.src, 4);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect((await r.store.load(r.scope))!.cursor).toBe('delta:4');
    for (const id of ['f01', 'f02', 'f03', 'f04']) r.src.touch(id, {});
    return r;
  }

  it('holds at the first page with an unresolved file, emits only what came before, retries next run', async () => {
    const r = await walked();
    r.src.failPerms.add('f03');
    const c = clock();
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { now: c.now });
    expect(out).toMatchObject({ held: true, unresolved: 1, indexed: 3 });
    expect(out.error).toMatch(/^permissions_unresolved: 1 file/);
    expect(r.fp.emitted.map((e) => e.payload.objectID)).toEqual([oid('f01'), oid('f02')]);
    let row = (await r.store.load(r.scope))!;
    expect(row).toMatchObject({ cursor: 'delta:6', last_status: 'error', unresolved_held_since: c.now() });
    expect(r.fp.acl.has(oid('f03'))).toBe(true); // the walk's row, untouched; only the re-stamp was missed

    r.src.failPerms.clear();
    r.fp.emitted.length = 0;
    c.advance(15 * 60_000);
    const retry = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { now: c.now });
    expect(retry.held).toBeUndefined();
    expect(retry.error).toBeUndefined();
    expect(r.fp.emitted.map((e) => e.payload.objectID)).toEqual([oid('f03'), oid('f04')]);
    row = (await r.store.load(r.scope))!;
    expect(row).toMatchObject({ cursor: 'delta:8', last_status: 'ok', unresolved_held_since: null });
  });

  it('a brand-new file whose permissions fail is indexed on the retry, not lost', async () => {
    const r = await rig('delta');
    await r.store.recordSuccess(r.scope, 'delta:0', 0, 0);
    r.src.put({ id: 'new', name: 'n.txt', mime: 'text/plain', perms: ['bob@corp.com'] });
    r.src.failPerms.add('new');
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(r.fp.acl.has(oid('new'))).toBe(false);
    expect((await r.store.load(r.scope))!.cursor).toBe('delta:0');
    r.src.failPerms.clear();
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(r.fp.acl.get(oid('new'))!.acl_principals).toEqual(['user:alice@corp.com', 'user:bob@corp.com']);
  });

  it('gives up after MAX_UNRESOLVED_HOLD_MS so one bad file cannot freeze the account', async () => {
    const r = await walked();
    r.src.failPerms.add('f03');
    const c = clock();
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { now: c.now });
    c.advance(6 * 60 * 60_000);
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { now: c.now });
    expect(out.held).toBeUndefined();
    expect(out.error).toMatch(/^permissions_unresolved_released: 1 file/);
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: 'delta:8', unresolved_held_since: null });
  });

  it('without a held-since column the hold has no limit but is reported every run', async () => {
    const r = await rig('delta');
    await r.store.recordSuccess(r.scope, 'delta:0', 0, 0);
    r.src.put({ id: 'x', name: 'x', mime: 'text/plain', perms: [] });
    r.src.failPerms.add('x');
    for (let i = 0; i < 3; i++) {
      const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { maxUnresolvedHoldMs: 0 });
      expect(out.held).toBe(true);
    }
    expect((await r.store.load(r.scope))!.last_error).toMatch(/permissions_unresolved/);
  });
});

describe('microsoft-365 shape: events, extra scopes, lease', () => {
  it('emits only for OneDrive rows, latches deletions, and gives a claim back when the emit fails', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 3);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    r.src.remove('f01');
    r.src.remove('f02');
    const claimed: string[] = [];
    const released: string[] = [];
    const adapter = {
      ...r.adapter,
      claimDeletedEvent: async (id: string) => {
        claimed.push(id);
        return id !== oid('f02'); // f02 was already announced by the webhook path
      },
      releaseDeletedEvent: async (id: string) => {
        released.push(id);
      },
    };
    const out = await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(claimed).toEqual([oid('f01'), oid('f02')]);
    expect(out.eventsEmitted).toBe(1);
    expect(r.fp.emitted[0]).toEqual({
      name: 'microsoft365.file.deleted',
      payload: { objectID: oid('f01'), itemId: 'f01', driveId: 'drive-1' },
    });
    r.src.remove('f03');
    r.fp.emitFailFor.add('microsoft365.file.deleted');
    await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(released).toEqual([oid('f03')]);
  });

  it('walks extra scopes after the main walk, defers the rest at the deadline, and never emits for them', async () => {
    const r = await rig('delta');
    await r.store.recordSuccess(r.scope, 'delta:0', 0, 0);
    r.src.put({ id: 'od', name: 'od.txt', mime: 'text/plain', perms: [] });
    let t = 0;
    const finished: ExtraScopesResult[] = [];
    const lib = (drive: string): FakeFile => ({ id: `${drive}-1`, name: 'doc.txt', mime: 'text/plain', perms: [], driveId: drive });
    const adapter = {
      ...r.adapter,
      extraScopes: async () => ({
        errorCode: 'sharepoint_drive_failed',
        scopes: [
          { id: 'sp-a', list: async () => ((t += 100), [lib('sp-a')]) },
          { id: 'sp-b', list: async () => [lib('sp-b')] },
          { id: 'sp-c', list: async () => [lib('sp-c')] },
        ],
        finish: async (res: ExtraScopesResult) => {
          finished.push(res);
          return { spDrivesDeferred: res.deferred };
        },
      }),
    };
    const out = await indexActorFiles(adapter, r.store, r.fp.env, r.scope, { deadline: { at: 50 }, now: () => t });
    expect(out).toMatchObject({ indexed: 2, extraScopesWalked: 1, extraScopesDeferred: 2, extra: { spDrivesDeferred: 2 } });
    expect(finished).toEqual([{ walked: ['sp-a'], deferredFrom: 'sp-b', deferred: 2, errors: [] }]);
    expect(r.fp.acl.has(oid('sp-a-1', 'sp-a'))).toBe(true);
    expect(r.fp.emitted.map((e) => e.payload.objectID)).toEqual([oid('od')]);
  });

  it('records a failed extra scope after advancing the main cursor', async () => {
    const r = await rig('delta');
    await r.store.recordSuccess(r.scope, 'delta:0', 0, 0);
    r.src.put({ id: 'od', name: 'od.txt', mime: 'text/plain', perms: [] });
    const adapter = {
      ...r.adapter,
      extraScopes: async () => ({
        errorCode: 'sharepoint_drive_failed',
        scopes: [{ id: 'sp-x', list: async () => Promise.reject(new Error('403 accessDenied')) }],
      }),
    };
    const out = await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(out.error).toBe('sharepoint_drive_failed: 403 accessDenied');
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: 'delta:1', last_status: 'error' });
  });

  it('does nothing when another invocation holds the scope', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 1);
    const adapter = {
      ...r.adapter,
      runExclusive: async () => ({ busy: true as const, purgePending: true }),
    };
    const out = await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(out).toMatchObject({ busy: true, purgePending: true, indexed: 0 });
    expect(r.fp.imports).toEqual([]);
  });

  it('sprigr-app-kit#99: passes the env, deadline and clock to runExclusive, and a 3-argument adapter still runs', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 1);
    const seen: Array<{ walkKey: string; run: unknown }> = [];
    const withRun = {
      ...r.adapter,
      async runExclusive<T>(_scope: FileIndexingScope, walkKey: string, fn: () => Promise<T>, run: unknown) {
        seen.push({ walkKey, run });
        return { busy: false as const, value: await fn() };
      },
    };
    const c = clock();
    const deadline = { at: c.now() + 60_000 };
    const out = await indexActorFiles(withRun, r.store, r.fp.env, r.scope, { deadline, now: c.now });
    expect(out.indexed).toBe(1);
    expect(seen).toEqual([{ walkKey: r.store.walkKey(r.scope), run: { env: r.fp.env, deadline, now: c.now, purpose: 'index' } }]);

    // A 0.1.0 adapter declares three parameters and ignores the fourth.
    const threeArg = {
      ...r.adapter,
      async runExclusive<T>(_scope: FileIndexingScope, _walkKey: string, fn: () => Promise<T>) {
        return { busy: false as const, value: await fn() };
      },
    };
    r.src.put({ id: 'late', name: 'late.txt', mime: 'text/plain', content: 'late', perms: [] });
    expect((await indexActorFiles(threeArg, r.store, r.fp.env, r.scope)).indexed).toBe(1);
  });

  it('treats a deadline error thrown mid-page as a cut, not a row error', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 4);
    let calls = 0;
    const deadlineErr = new Error('graph deadline');
    const adapter = {
      ...r.adapter,
      isDeadlineError: (e: unknown) => e === deadlineErr,
      fullWalk: async (t: string | null, ctx: Parameters<typeof r.adapter.fullWalk>[1]) => {
        if (++calls === 2) throw deadlineErr;
        return r.adapter.fullWalk(t, ctx);
      },
    };
    const out = await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(out).toMatchObject({ cut: true, indexed: 2 });
    expect(out.error).toBeUndefined();
    expect((await r.store.load(r.scope))!.cursor).toBe('full:2');
  });
});
