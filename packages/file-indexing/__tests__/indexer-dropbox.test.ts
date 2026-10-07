/**
 * Proof that a Dropbox adapter fits the seam with no package change:
 * files/list_folder(recursive) for the full walk, list_folder/continue for
 * changes, a 409 `reset` that means start over, and principals from
 * sharing/list_file_members with a per-shared-folder cache. Runs on the
 * package's DEFAULT tables and config (DEFAULT_FILE_INDEXING_SCHEMA_SQL), the
 * way a new app with no file-indexing tables would start.
 */
import { describe, expect, it } from 'vitest';
import {
  PURGE_DELETE_CHUNK,
  buildContext,
  emptyWalkMarkerKey,
  indexActorFiles,
  purgeActor,
  reconcileWalk,
} from '../src/indexer';
import { BOB, rig } from './helpers/setup';

const oid = (id: string) => `dbx:file:u:user_alice:${id}`;

describe('dropbox shape', () => {
  it('walks list_folder, then follows list_folder/continue, with one member read per shared folder', async () => {
    const r = await rig('dropbox');
    r.src.pageSize = 10;
    r.src.sharedFolders.set('sf-1', ['carol@corp.com', 'Dave@Corp.com']);
    r.src.put({ id: 'a', name: 'a.txt', mime: 'text/plain', content: 'A', sharedFolderId: 'sf-1' });
    r.src.put({ id: 'b', name: 'b.txt', mime: 'text/plain', content: 'B', sharedFolderId: 'sf-1' });
    r.src.put({ id: 'c', name: 'c.txt', mime: 'text/plain', content: 'C', link: true });
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out).toMatchObject({ indexed: 3, skipped: 0 });
    expect(r.src.sharedFolderCalls).toBe(1);
    expect(r.fp.acl.get(oid('a'))!.acl_principals).toEqual([
      'user:alice@corp.com',
      'user:carol@corp.com',
      'user:dave@corp.com',
    ]);
    // A shared link (any scope) stamps nothing beyond the owner.
    expect(r.fp.acl.get(oid('c'))!.acl_principals).toEqual(['user:alice@corp.com']);
    expect((await r.store.load(r.scope))!.cursor).toBe('dbx:chg:3');

    r.src.touch('a', { content: 'A2' });
    r.src.remove('b');
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(r.fp.acl.get(oid('a'))!.content).toBe('A2');
    expect(r.fp.acl.has(oid('b'))).toBe(false);
    expect(r.fp.emitted.map((e) => e.name)).toEqual(['dropbox.file.updated', 'dropbox.file.deleted']);
  });

  it('a 409 reset clears the cursor, records the error, and the next run walks from scratch', async () => {
    const r = await rig('dropbox');
    r.src.put({ id: 'a', name: 'a.txt', mime: 'text/plain', perms: [] });
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    r.src.resetNext = true;
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out.error).toBe('list_folder_cursor_reset');
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: null, last_status: 'error' });
    const again = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(again).toMatchObject({ indexed: 1, reconciled: 0 });
    expect((await r.store.load(r.scope))!.cursor).toBe('dbx:chg:1');
  });
});


describe('sprigr-apps#2690: an emptied account sheds its rows only after two confirmed empty walks', () => {
  type R = Awaited<ReturnType<typeof rig>>;
  /** 63 stale rows of this account (the staging count) plus one of another account. */
  function seedStale(r: R, n = 63): void {
    for (let i = 0; i < n; i++) {
      const id = oid(`gone-${String(i).padStart(3, '0')}`);
      r.fp.acl.set(id, { objectID: id, acl_principals: ['user:alice@corp.com'], content: 'quokka pallet recall' });
    }
    r.fp.acl.set('dbx:file:u:user_bob:keep', { objectID: 'dbx:file:u:user_bob:keep', acl_principals: ['user:bob@corp.com'] });
  }
  const ours = (r: R) => [...r.fp.acl.keys()].filter((k) => k.startsWith(oid('')));
  const marks = async (r: R) => (await r.store.listWalkSeen(emptyWalkMarkerKey(r.store.walkKey(r.scope)))).length;
  const walk = (r: R, adapter = r.adapter, budget = {}) => indexActorFiles(adapter, r.store, r.fp.env, r.scope, budget);

  it('first confirmed empty walk: nothing deleted, marker set, and a follow-up full walk is requested', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    const out = await walk(r);
    expect(out).toMatchObject({ indexed: 0, reconciled: 0, emptyWalkFollowUp: true });
    expect(out.error).toBeUndefined();
    expect(r.fp.deletes).toEqual([]);
    expect(ours(r)).toHaveLength(63);
    expect(r.src.confirmEmptyCalls).toBe(1);
    expect(await marks(r)).toBe(1);
    // A NULL cursor: the next pass is a full walk without anyone toggling indexing.
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: null, full_walk_active: 0, last_status: 'ok' });
  });

  it('second consecutive confirmed empty walk deletes every row under the account prefix, and nothing else', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    await r.store.upsertPendingExtraction({ objectId: oid('gone-000'), jobToken: 'j', recordJson: '{}', format: 'pptx' });
    await walk(r);
    const out = await walk(r);
    expect(out).toMatchObject({ indexed: 0, reconciled: 63 });
    expect(out.emptyWalkFollowUp).toBeUndefined();
    expect(out.error).toBeUndefined();
    expect(ours(r)).toEqual([]);
    expect(r.fp.acl.has('dbx:file:u:user_bob:keep')).toBe(true);
    expect(await r.store.listPendingExtractions(5)).toEqual([]);
    expect(r.src.confirmEmptyCalls).toBe(2);
    expect(await marks(r)).toBe(0);
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: 'dbx:chg:0', full_walk_active: 0 });
    // Back to incremental passes: no third walk, no more confirmations.
    await walk(r);
    expect(r.src.confirmEmptyCalls).toBe(2);
  });

  it('an adapter without confirmEmpty never deletes on an empty walk (microsoft-365 and google-workspace unchanged)', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    const { confirmEmpty: _drop, ...noHook } = r.adapter;
    for (let i = 0; i < 3; i++) {
      const out = await walk(r, noHook);
      expect(out).toMatchObject({ reconciled: 0 });
      expect(out.emptyWalkFollowUp).toBeUndefined();
      await r.store.resetCursor(r.scope); // force another full walk
    }
    expect(ours(r)).toHaveLength(63);
    expect(r.fp.deletes).toEqual([]);
    expect(await marks(r)).toBe(0);

    const gw = await rig('drive');
    for (const id of ['gw:file:x', 'gw:file:y']) gw.fp.acl.set(id, { objectID: id, acl_principals: ['user:alice@corp.com'] });
    for (let i = 0; i < 2; i++) {
      expect(await walk(gw)).toMatchObject({ reconciled: 0 });
      await gw.store.resetCursor(gw.scope);
    }
    expect(gw.fp.acl.size).toBe(2);
  });

  it('confirmEmpty false: nothing deleted, marker not advanced, no follow-up walk', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    await walk(r); // marker 1
    r.src.confirmEmptyAnswer = false;
    const out = await walk(r);
    expect(out).toMatchObject({ reconciled: 0 });
    expect(out.emptyWalkFollowUp).toBeUndefined();
    expect(await marks(r)).toBe(1);
    expect(ours(r)).toHaveLength(63);
    expect(r.fp.deletes).toEqual([]);
    expect((await r.store.load(r.scope))!.cursor).toBe('dbx:chg:0');
  });

  it('confirmEmpty throws: nothing deleted, marker not advanced, the cursor is kept so the next pass walks again', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    await walk(r); // marker 1
    r.src.confirmEmptyAnswer = 'throw';
    const out = await walk(r);
    expect(out.error).toBe('reconcile_failed: 503 list_folder failed');
    expect(await marks(r)).toBe(1);
    expect(ours(r)).toHaveLength(63);
    expect(r.fp.deletes).toEqual([]);
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: null, last_status: 'error' });
    // Recovered: that retry is the second confirmed empty walk.
    r.src.confirmEmptyAnswer = undefined;
    expect(await walk(r)).toMatchObject({ reconciled: 63 });
  });

  it('a walk that sees entries in between clears the marker', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    await walk(r); // marker 1, follow-up requested
    r.src.put({ id: 'new', name: 'new.txt', mime: 'text/plain', content: 'N' });
    const seen = await walk(r); // the follow-up walk sees a file: unseen rows go by the normal diff
    expect(seen).toMatchObject({ indexed: 1, reconciled: 63 });
    expect(await marks(r)).toBe(0);
    r.src.remove('new');
    await r.store.resetCursor(r.scope);
    // The next empty walk is the FIRST of a new run, so its row stays for now.
    expect(await walk(r)).toMatchObject({ reconciled: 0, emptyWalkFollowUp: true });
    expect(await marks(r)).toBe(1);
    expect(r.fp.acl.has(oid('new'))).toBe(true);
  });

  it("other actors' rows are untouched: install-scoped ids with another indexer never purge", async () => {
    const gw = await rig('drive');
    const adapter = { ...gw.adapter, confirmEmpty: async () => true };
    for (const id of ['gw:file:x', 'gw:file:y']) gw.fp.acl.set(id, { objectID: id, acl_principals: ['user:alice@corp.com'] });
    await gw.store.enable({ actor: BOB }, { connectedEmail: 'bob@corp.com' });
    for (let i = 0; i < 3; i++) {
      expect(await walk(gw, adapter)).toMatchObject({ reconciled: 0 });
      await gw.store.resetCursor(gw.scope);
    }
    expect(gw.fp.acl.size).toBe(2);
    expect(gw.fp.deletes).toEqual([]);

    // The only indexer: two confirmed empty walks purge the install prefix.
    const solo = await rig('drive');
    const soloAdapter = { ...solo.adapter, confirmEmpty: async () => true };
    for (const id of ['gw:file:x', 'gw:file:y']) solo.fp.acl.set(id, { objectID: id, acl_principals: ['user:alice@corp.com'] });
    expect(await walk(solo, soloAdapter)).toMatchObject({ reconciled: 0, emptyWalkFollowUp: true });
    expect(await walk(solo, soloAdapter)).toMatchObject({ reconciled: 2 });
    expect(solo.fp.acl.size).toBe(0);
  });

  it('an adapter with reconcilePrefixes still decides which prefixes an empty walk covers', async () => {
    const r = await rig('delta');
    const adapter = { ...r.adapter, confirmEmpty: async () => true };
    const sp = 'ms:file:u:user_alice:sp-lib:doc';
    r.fp.acl.set(sp, { objectID: sp, acl_principals: ['user:alice@corp.com'] });
    for (let i = 0; i < 2; i++) {
      expect(await walk(r, adapter)).toMatchObject({ reconciled: 0 });
      await r.store.resetCursor(r.scope);
    }
    expect(r.fp.acl.has(sp)).toBe(true);
  });

  it('the purge resumes across passes when the deadline cuts it', async () => {
    const r = await rig('dropbox');
    seedStale(r, 600); // three delete chunks of PURGE_DELETE_CHUNK
    let t = 0;
    const data = r.fp.env.SPRIGR!.data!;
    const del = data.delete!.bind(data);
    data.delete = async (ids, o) => {
      const res = await del(ids, o);
      t = 98_000; // under MIN_PURGE_LEG_MS left before the next chunk
      return res;
    };
    const budget = () => {
      t = 0;
      return { deadline: { at: 100_000 }, now: () => t, contentFillBudgetMs: 0 };
    };
    expect(await walk(r, r.adapter, budget())).toMatchObject({ reconciled: 0, emptyWalkFollowUp: true });
    const cut = await walk(r, r.adapter, budget());
    expect(cut).toMatchObject({ reconciled: PURGE_DELETE_CHUNK, emptyWalkFollowUp: true });
    expect(ours(r)).toHaveLength(600 - PURGE_DELETE_CHUNK);
    expect((await r.store.load(r.scope))!.cursor).toBeNull();
    expect(await walk(r, r.adapter, budget())).toMatchObject({ reconciled: PURGE_DELETE_CHUNK, emptyWalkFollowUp: true });
    const last = await walk(r, r.adapter, budget());
    expect(last).toMatchObject({ reconciled: 600 - 2 * PURGE_DELETE_CHUNK });
    expect(last.emptyWalkFollowUp).toBeUndefined();
    expect(ours(r)).toEqual([]);
    expect(r.fp.acl.has('dbx:file:u:user_bob:keep')).toBe(true);
    expect(r.src.confirmEmptyCalls).toBe(4); // every resumed pass confirms again
    expect(await marks(r)).toBe(0);
  });

  it('a truncated listing deletes the listed subset and asks for another walk to continue', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    r.fp.listTruncated = true; // the fake lists only the first id, truncated: true
    await walk(r);
    expect(await walk(r)).toMatchObject({ reconciled: 1, emptyWalkFollowUp: true });
    expect(r.fp.deletes).toEqual([[oid('gone-000')]]);
    expect(await walk(r)).toMatchObject({ reconciled: 1, emptyWalkFollowUp: true });
    expect(ours(r)).toHaveLength(61);
  });

  it('an errored, cut or cursorless empty walk deletes nothing and records no marker', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    await walk(r); // marker 1
    const failing = {
      ...r.adapter,
      fullWalk: async () => {
        throw new Error('500 list_folder failed');
      },
    };
    expect((await walk(r, failing)).error).toBe('500 list_folder failed');
    expect(await walk(r, r.adapter, { deadline: { at: 1_000 }, now: () => 2_000 })).toMatchObject({ cut: true, pagesWalked: 0 });
    const cursorless = { ...r.adapter, fullWalk: async () => ({ entries: [], cursor: null, hasMore: false }) };
    await walk(r, cursorless);
    expect(r.fp.deletes).toEqual([]);
    expect(ours(r)).toHaveLength(63);
    expect(r.src.confirmEmptyCalls).toBe(1);
    expect(await marks(r)).toBe(1);
  });

  it('an empty account with nothing indexed asks nothing and walks once', async () => {
    const r = await rig('dropbox');
    const out = await walk(r);
    expect(out).toMatchObject({ reconciled: 0 });
    expect(out.emptyWalkFollowUp).toBeUndefined();
    expect(r.src.confirmEmptyCalls).toBe(0);
    expect((await r.store.load(r.scope))!.cursor).toBe('dbx:chg:0');
  });

  it('purgeActor and a re-enable clear the marker, so an old empty walk never counts toward a new run', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    await walk(r);
    expect(await marks(r)).toBe(1);
    await r.store.enable(r.scope, { connectedEmail: 'alice@corp.com' });
    expect(await marks(r)).toBe(0);
    await walk(r);
    expect(await marks(r)).toBe(1);
    await purgeActor(r.adapter, r.store, r.fp.env, r.scope);
    expect(await marks(r)).toBe(0);
  });

  it('a direct reconcileWalk call: without completedWalk an empty seen set deletes nothing; with it, two confirmed calls purge', async () => {
    const r = await rig('dropbox');
    seedStale(r, 2);
    const ctx = () => r.store.load(r.scope).then((row) => buildContext(r.fp.env, r.store, r.scope, row!));
    expect(await reconcileWalk(r.adapter, r.store, await ctx())).toBe(0);
    expect(await marks(r)).toBe(0);
    expect(await reconcileWalk(r.adapter, r.store, await ctx(), { completedWalk: true })).toBe(0);
    expect(ours(r)).toHaveLength(2);
    expect(await reconcileWalk(r.adapter, r.store, await ctx(), { completedWalk: true })).toBe(2);
    expect(ours(r)).toEqual([]);
  });
});
