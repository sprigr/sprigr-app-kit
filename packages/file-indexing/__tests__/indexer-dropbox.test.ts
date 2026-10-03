/**
 * Proof that a Dropbox adapter fits the seam with no package change:
 * files/list_folder(recursive) for the full walk, list_folder/continue for
 * changes, a 409 `reset` that means start over, and principals from
 * sharing/list_file_members with a per-shared-folder cache. Runs on the
 * package's DEFAULT tables and config (DEFAULT_FILE_INDEXING_SCHEMA_SQL), the
 * way a new app with no file-indexing tables would start.
 */
import { describe, expect, it } from 'vitest';
import { buildContext, indexActorFiles, reconcileWalk } from '../src/indexer';
import { rig } from './helpers/setup';

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

describe('sprigr-apps#2690: a completed full walk of an EMPTY source reconciles', () => {
  /** 63 stale rows of this account (the staging count) plus one of another account. */
  function seedStale(r: Awaited<ReturnType<typeof rig>>, n = 63): void {
    for (let i = 0; i < n; i++) {
      const id = oid(`gone-${String(i).padStart(2, '0')}`);
      r.fp.acl.set(id, { objectID: id, acl_principals: ['user:alice@corp.com'], content: 'quokka pallet recall' });
    }
    r.fp.acl.set('dbx:file:u:user_bob:keep', { objectID: 'dbx:file:u:user_bob:keep', acl_principals: ['user:bob@corp.com'] });
  }
  const ours = (r: Awaited<ReturnType<typeof rig>>) => [...r.fp.acl.keys()].filter((k) => k.startsWith(oid('')));

  it('(a) deletes every row under the prefix, and nothing under another prefix', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    await r.store.upsertPendingExtraction({ objectId: oid('gone-00'), jobToken: 'j', recordJson: '{}', format: 'pptx' });
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out).toMatchObject({ indexed: 0, reconciled: 63 });
    expect(out.error).toBeUndefined();
    expect(ours(r)).toEqual([]);
    expect(r.fp.acl.has('dbx:file:u:user_bob:keep')).toBe(true);
    expect(await r.store.listPendingExtractions(5)).toEqual([]);
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: 'dbx:chg:0', full_walk_active: 0 });
  });

  it('(a) install-scoped ids (google-workspace shape) purge too when this actor is the only indexer', async () => {
    const r = await rig('drive');
    for (const id of ['gw:file:x', 'gw:file:y']) r.fp.acl.set(id, { objectID: id, acl_principals: ['user:alice@corp.com'] });
    expect(await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope)).toMatchObject({ reconciled: 2 });
    expect(r.fp.acl.size).toBe(0);
  });

  it('(a) an adapter with reconcilePrefixes still decides (microsoft-365 keeps SharePoint rows out of the diff)', async () => {
    const r = await rig('delta');
    const sp = 'ms:file:u:user_alice:sp-lib:doc';
    r.fp.acl.set(sp, { objectID: sp, acl_principals: ['user:alice@corp.com'] });
    expect(await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope)).toMatchObject({ reconciled: 0 });
    expect(r.fp.acl.has(sp)).toBe(true);
  });

  it('(b) an errored empty walk deletes nothing', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    const adapter = {
      ...r.adapter,
      fullWalk: async () => {
        throw new Error('500 list_folder failed');
      },
    };
    const out = await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(out.error).toBe('500 list_folder failed');
    expect(ours(r)).toHaveLength(63);
    expect(r.fp.deletes).toEqual([]);
  });

  it('(b) a budget-cut empty walk deletes nothing', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { deadline: { at: 1_000 }, now: () => 2_000 });
    expect(out).toMatchObject({ cut: true, pagesWalked: 0 });
    expect(out.reconciled).toBeUndefined();
    expect(ours(r)).toHaveLength(63);
    expect(r.fp.deletes).toEqual([]);
  });

  it('(b) an empty final page that establishes no cursor cannot prove completion: nothing deleted', async () => {
    const r = await rig('drive');
    r.fp.acl.set('gw:file:x', { objectID: 'gw:file:x', acl_principals: ['user:alice@corp.com'] });
    const adapter = { ...r.adapter, seedCursor: undefined, fullWalk: async () => ({ entries: [], cursor: null, hasMore: false }) };
    await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(r.fp.acl.has('gw:file:x')).toBe(true);
    expect(r.fp.deletes).toEqual([]);
  });

  it('(c) a truncated listing deletes nothing on an empty walk', async () => {
    const r = await rig('dropbox');
    seedStale(r);
    r.fp.listTruncated = true;
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out).toMatchObject({ reconciled: 0 });
    expect(ours(r)).toHaveLength(63);
    expect(r.fp.deletes).toEqual([]);
    expect((await r.store.load(r.scope))!.full_walk_active).toBe(0);
  });

  it('a direct reconcileWalk call without completedWalk keeps 0.1.0 behaviour: an empty seen set deletes nothing', async () => {
    const r = await rig('dropbox');
    seedStale(r, 2);
    const row = (await r.store.load(r.scope))!;
    expect(await reconcileWalk(r.adapter, r.store, buildContext(r.fp.env, r.store, r.scope, row))).toBe(0);
    expect(ours(r)).toHaveLength(2);
    expect(await reconcileWalk(r.adapter, r.store, buildContext(r.fp.env, r.store, r.scope, row), { completedWalk: true })).toBe(2);
    expect(ours(r)).toEqual([]);
  });
});
