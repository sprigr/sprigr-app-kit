/**
 * Proof that a Dropbox adapter fits the seam with no package change:
 * files/list_folder(recursive) for the full walk, list_folder/continue for
 * changes, a 409 `reset` that means start over, and principals from
 * sharing/list_file_members with a per-shared-folder cache. Runs on the
 * package's DEFAULT tables and config (DEFAULT_FILE_INDEXING_SCHEMA_SQL), the
 * way a new app with no file-indexing tables would start.
 */
import { describe, expect, it } from 'vitest';
import { indexActorFiles } from '../src/indexer';
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
