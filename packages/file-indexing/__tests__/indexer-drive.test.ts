/**
 * indexActorFiles over a google-workspace-shaped adapter and the real
 * gw_file_indexing schema: a files.list full walk that resumes across ticks
 * from its own continuation columns, then the changes feed.
 */
import { describe, expect, it } from 'vitest';
import { indexActorFiles } from '../src/indexer';
import { BOB, rig, seedFiles } from './helpers/setup';

describe('google-workspace shape: full walk', () => {
  it('walks the tree, stamps principals, imports, reconciles, and seeds the cursor from the baseline', async () => {
    const r = await rig('drive');
    seedFiles(r.src, 5);
    r.fp.acl.set('gw:file:gone', { objectID: 'gw:file:gone', acl_principals: ['user:x@y.com'] });
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out).toMatchObject({ indexed: 5, skipped: 0, pagesWalked: 3, reconciled: 1 });
    expect(out.error).toBeUndefined();
    expect(r.fp.acl.get('gw:file:f01')).toMatchObject({
      acl_principals: ['user:alice@corp.com', 'user:bob@corp.com'],
      content: 'body 1',
      fileId: 'f01',
    });
    expect(r.fp.acl.has('gw:file:gone')).toBe(false);
    const row = (await r.store.load(r.scope))!;
    expect(row).toMatchObject({ cursor: 'chg:5', full_walk_active: 0, walk_list_token: null, walk_start_token: null });
    expect(r.fp.emitted).toEqual([]); // a full walk is history, not news
    expect(r.fp.links).toEqual([{ op: 'link', owner: { kind: 'user', id: 'user_alice' }, email: 'alice@corp.com' }]);
  });

  it('resumes a walk across ticks from walk_list_token, never storing a cursor mid-walk', async () => {
    const r = await rig('drive');
    seedFiles(r.src, 5);
    const t1 = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { maxPages: 1 });
    expect(t1).toMatchObject({ indexed: 2, pagesWalked: 1 });
    let row = (await r.store.load(r.scope))!;
    expect(row).toMatchObject({ cursor: null, full_walk_active: 1, walk_list_token: 'list:2', walk_start_token: 'chg:5' });
    // A change made DURING the walk is caught by the baseline captured before it.
    r.src.put({ id: 'f09', name: 'late.txt', mime: 'text/plain', perms: [] });
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { maxPages: 1 });
    row = (await r.store.load(r.scope))!;
    expect(row).toMatchObject({ walk_list_token: 'list:4', walk_start_token: 'chg:5' });
    const t3 = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { maxPages: 1 });
    expect(t3.reconciled).toBe(0);
    row = (await r.store.load(r.scope))!;
    expect(row).toMatchObject({ cursor: 'chg:5', full_walk_active: 0, walk_list_token: null });
    const t4 = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(r.fp.emitted.map((e) => e.name)).toEqual(['google.file.created']);
    expect(t4.indexed).toBe(1);
  });

  it('restarts from the top when the stored continuation is rejected', async () => {
    const r = await rig('drive');
    seedFiles(r.src, 3);
    await r.store.setFullWalkActive(r.scope, true);
    await r.store.recordWalkProgress(r.scope, { listToken: 'list:STALE', startToken: 'chg:0', indexed: 0, skipped: 0 });
    await r.store.recordWalkSeen(r.store.walkKey(r.scope), ['gw:file:old']);
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out.error).toBeUndefined();
    expect(out.indexed).toBe(3);
    expect((await r.store.load(r.scope))!.cursor).toBe('chg:3');
  });

  it('restarts a legacy abandoned walk (cursor + active flag, no continuation)', async () => {
    const r = await rig('drive');
    seedFiles(r.src, 2);
    await r.store.recordSuccess(r.scope, 'chg:1', 0, 0);
    await r.store.setFullWalkActive(r.scope, true);
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out.indexed).toBe(2);
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: 'chg:2', full_walk_active: 0 });
  });

  it('does not reconcile install-scoped rows while another actor indexes', async () => {
    const r = await rig('drive');
    await r.store.enable({ actor: BOB }, { connectedEmail: 'bob@corp.com' });
    seedFiles(r.src, 2);
    r.fp.acl.set('gw:file:bobs', { objectID: 'gw:file:bobs', acl_principals: ['user:bob@corp.com'] });
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out.reconciled).toBe(0);
    expect(r.fp.acl.has('gw:file:bobs')).toBe(true);
    expect((await r.store.load(r.scope))!.full_walk_active).toBe(0);
  });
});

describe('google-workspace shape: fail closed', () => {
  it('skips a file whose permissions are hidden, and never stamps public for a link share', async () => {
    const r = await rig('drive');
    r.src.put({ id: 'hidden', name: 'h', mime: 'text/plain' }); // perms undefined
    r.src.put({ id: 'linked', name: 'l', mime: 'text/plain', perms: [], link: true });
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out).toMatchObject({ indexed: 1, skipped: 1, unresolved: 0 });
    expect(r.fp.acl.has('gw:file:hidden')).toBe(false);
    expect(r.fp.acl.get('gw:file:linked')!.acl_principals).toEqual(['user:alice@corp.com']);
    for (const row of r.fp.acl.values()) expect(row.acl_principals).not.toContain('public');
    expect((await r.store.load(r.scope))!.files_skipped).toBe(1);
  });

  it('with no owner and no grants a file has no valid principal and is skipped', async () => {
    const r = await rig('drive');
    await r.store.remove(r.scope);
    await r.store.enable(r.scope, { connectedEmail: null });
    r.src.put({ id: 'lonely', name: 'x', mime: 'text/plain', perms: [] });
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out).toMatchObject({ indexed: 0, skipped: 1 });
    expect(r.fp.imports).toEqual([]);
  });

  it('backfills a missing owner email, then restamps from a reset cursor', async () => {
    const r = await rig('drive');
    await r.store.remove(r.scope);
    await r.store.enable(r.scope, { connectedEmail: null });
    await r.store.recordSuccess(r.scope, 'chg:0', 0, 0);
    r.src.put({ id: 'a', name: 'a', mime: 'text/plain', perms: [] });
    const adapter = { ...r.adapter, resolveOwnerEmail: async () => 'Owner@Corp.com' };
    const out = await indexActorFiles(adapter, r.store, r.fp.env, r.scope);
    expect(out.indexed).toBe(1);
    expect(r.fp.acl.get('gw:file:a')!.acl_principals).toEqual(['user:owner@corp.com']);
    expect((await r.store.load(r.scope))!.connected_email).toBe('Owner@Corp.com');
  });
});

describe('google-workspace shape: incremental', () => {
  it('imports changes, deletes removals, and emits created/updated/deleted', async () => {
    const r = await rig('drive');
    seedFiles(r.src, 3);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    r.src.touch('f02', { name: 'renamed.txt' });
    r.src.remove('f03');
    r.src.put({ id: 'f07', name: 'new.txt', mime: 'text/plain', perms: [] });
    await r.store.upsertPendingExtraction({ objectId: 'gw:file:f03', jobToken: 'j', recordJson: '{}', format: 'pptx' });
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out).toMatchObject({ indexed: 2, eventsEmitted: 3 });
    expect(r.fp.acl.get('gw:file:f02')!.name).toBe('renamed.txt');
    expect(r.fp.acl.has('gw:file:f03')).toBe(false);
    expect(await r.store.listPendingExtractions(5)).toEqual([]);
    expect(r.fp.emitted.map((e) => [e.name, e.payload.objectID])).toEqual([
      ['google.file.updated', 'gw:file:f02'],
      ['google.file.deleted', 'gw:file:f03'],
      ['google.file.created', 'gw:file:f07'],
    ]);
    expect(r.fp.emitted[0]!.payload).toMatchObject({ fileId: 'f02', name: 'renamed.txt', source: 'google-drive' });
    expect(r.fp.emitted[1]!.payload).toEqual({ objectID: 'gw:file:f03', fileId: 'f03' });
    expect((await r.store.load(r.scope))!.cursor).toBe('chg:6');
  });

  it('resets an expired cursor and records the app error string', async () => {
    const r = await rig('drive');
    await r.store.recordSuccess(r.scope, 'chg:EXPIRED', 0, 0);
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out.error).toBe('page_token_expired_reset');
    expect((await r.store.load(r.scope))!).toMatchObject({ cursor: null, last_status: 'error', last_error: 'page_token_expired_reset' });
  });

  it('keeps the cursor when the import fails', async () => {
    const r = await rig('drive');
    seedFiles(r.src, 1);
    await r.store.recordSuccess(r.scope, 'chg:0', 0, 0);
    r.fp.failImport = true;
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out.error).toMatch(/^import_failed: /);
    expect((await r.store.load(r.scope))!.cursor).toBe('chg:0');
  });

  it('stops at the deadline on a page boundary and resumes from there', async () => {
    const r = await rig('drive');
    seedFiles(r.src, 4);
    await r.store.recordSuccess(r.scope, 'chg:0', 0, 0);
    let t = 0;
    const now = () => t;
    const adapter = {
      ...r.adapter,
      listChanges: async (c: string, ctx: Parameters<typeof r.adapter.listChanges>[1]) => {
        t += 10;
        return r.adapter.listChanges(c, ctx);
      },
    };
    const out = await indexActorFiles(adapter, r.store, r.fp.env, r.scope, { deadline: { at: 10 }, now });
    expect(out).toMatchObject({ cut: true, indexed: 2, pagesWalked: 1 });
    expect((await r.store.load(r.scope))!.cursor).toBe('chg:2');
  });

  it('skips a disabled row and reports a missing one', async () => {
    const r = await rig('drive');
    await r.store.disable(r.scope);
    expect(await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope)).toMatchObject({ indexed: 0, pagesWalked: 0 });
    expect((await indexActorFiles(r.adapter, r.store, r.fp.env, { actor: BOB })).error).toBe('no_file_indexing_row');
  });
});
