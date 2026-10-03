/**
 * The D1 store against both apps' real schemas (sql.js). The point is the
 * column-name parameterisation: one implementation must read and write
 * gw_file_indexing (page_token, walk-resume columns, no connection) and
 * ms_file_indexing (delta_link, connection_id, acl-refresh columns) without
 * touching a column the other app does not have.
 */
import { describe, expect, it } from 'vitest';
import { createD1FileIndexingStore, defaultRedact, GOOGLE_WORKSPACE_STORE_CONFIG } from '../src/d1-store';
import { ALICE, BOB, rig } from './helpers/setup';
import { GOOGLE_WORKSPACE_SCHEMA } from './helpers/schemas';
import { makeSqliteD1 } from './helpers/sqlite-d1';

describe('createD1FileIndexingStore on the google-workspace schema', () => {
  it('enables, records progress and success, and resets with the walk columns', async () => {
    const { store, scope, db } = await rig('drive');
    expect(store.hasWalkResumeColumns).toBe(true);
    expect(store.hasAclRefreshColumns).toBe(false);
    let row = (await store.load(scope))!;
    expect(row).toMatchObject({ enabled: 1, cursor: null, connected_email: 'Alice@Corp.com', full_walk_active: 0 });

    await store.recordWalkProgress(scope, { listToken: 'list:4', startToken: 'chg:9', indexed: 3, skipped: 1 });
    row = (await store.load(scope))!;
    expect(row).toMatchObject({ cursor: null, walk_list_token: 'list:4', walk_start_token: 'chg:9', files_indexed: 3, files_skipped: 1 });

    await store.recordSuccess(scope, 'chg:9', 2, 0);
    row = (await store.load(scope))!;
    expect(row).toMatchObject({ cursor: 'chg:9', walk_list_token: null, walk_start_token: null, files_indexed: 5, last_status: 'ok' });

    await store.recordError(scope, 'boom Authorization: Bearer abc.def access_token=xyz');
    row = (await store.load(scope))!;
    expect(row.last_status).toBe('error');
    expect(row.last_error).not.toContain('abc.def');
    expect(row.last_error).not.toContain('xyz');
    expect(row.cursor).toBe('chg:9');

    await store.resetCursor(scope);
    expect((await store.load(scope))!.cursor).toBeNull();
    expect(db.all('SELECT page_token FROM gw_file_indexing')).toEqual([{ page_token: null }]);
  });

  it('keeps agent rows and user rows apart, with no reverse fallback', async () => {
    const { store } = await rig('drive');
    const agent = { agentId: 'agt_1' };
    expect(await store.load({ actor: agent })).toBeNull();
    await store.enable({ actor: agent }, { connectedEmail: 'bot@corp.com' });
    expect((await store.load({ actor: agent }))!.connected_email).toBe('bot@corp.com');
    // A user-bound agent resolves to the USER row, never the agent row.
    expect((await store.load({ actor: { platformUserId: 'user_alice', agentId: 'agt_1' } }))!.connected_email).toBe('Alice@Corp.com');
    expect(await store.countOtherActors({ actor: ALICE })).toBe(1);
    expect(await store.countOtherActors({ actor: BOB })).toBe(2);
  });

  it('countOtherActors is one query and counts agent rows (NULL user id) too', async () => {
    const { store, db } = await rig('drive');
    await store.enable({ actor: { agentId: 'agt_1' } }, { connectedEmail: null });
    await store.enable({ actor: BOB }, { connectedEmail: null });
    let prepares = 0;
    const counting = createD1FileIndexingStore(
      { prepare: (sql: string) => (prepares++, db.prepare(sql)) },
      GOOGLE_WORKSPACE_STORE_CONFIG,
    );
    expect(await counting.countOtherActors({ actor: ALICE })).toBe(2);
    expect(prepares).toBe(1);
    expect(await counting.countOtherActors({ actor: { agentId: 'agt_1' } })).toBe(2);
    expect(await counting.countOtherActors({ actor: { agentId: 'agt_2' } })).toBe(3);
  });

  it('lists enabled rows stale-first with their scopes', async () => {
    const { store } = await rig('drive');
    await store.enable({ actor: BOB }, { connectedEmail: 'bob@corp.com' });
    await store.recordSuccess({ actor: BOB }, 'chg:1', 0, 0);
    await store.disable({ actor: { agentId: 'nobody' } });
    const listed = await store.listEnabled();
    expect(listed.map((l) => l.scope.actor.platformUserId)).toEqual(['user_alice', 'user_bob']);
    expect(listed[0]!.scope.connectionId).toBeUndefined();
  });

  it('walk-seen and pending-extraction tables round-trip in chunks', async () => {
    const { store } = await rig('drive');
    const ids = Array.from({ length: 95 }, (_, i) => `gw:file:${i}`);
    await store.recordWalkSeen('k', ids);
    await store.recordWalkSeen('k', ids.slice(0, 5));
    expect((await store.listWalkSeen('k')).length).toBe(95);
    await store.clearWalkSeen('k');
    expect(await store.listWalkSeen('k')).toEqual([]);

    for (const id of ids.slice(0, 3)) await store.upsertPendingExtraction({ objectId: id, jobToken: 't', recordJson: '{}', format: 'pptx' });
    await store.bumpPendingExtraction('gw:file:0');
    await store.upsertPendingExtraction({ objectId: 'gw:file:0', jobToken: 't2', recordJson: '{"a":1}', format: 'pptx' });
    const listed = await store.listPendingExtractions(10);
    expect(listed.find((r) => r.object_id === 'gw:file:0')).toMatchObject({ job_token: 't2', attempts: 0 });
    expect((await store.listPendingExtractionsFor(ids)).length).toBe(3);
    await store.deletePendingExtractions(ids);
    expect(await store.listPendingExtractions(10)).toEqual([]);
  });

  it('refuses a connection scope and the re-stamp columns it does not have', async () => {
    const { store } = await rig('drive');
    await expect(store.load({ actor: ALICE, connectionId: 'c' })).rejects.toThrow(/no connectionColumn/);
    await expect(store.setAclRefresh({ actor: ALICE }, null, 1)).rejects.toThrow(/aclRefreshColumns/);
    await store.setUnresolvedHeldSince({ actor: ALICE }, 5); // no column: a no-op, not an error
  });

  it('rejects table and column names that are not plain identifiers', async () => {
    const db = await makeSqliteD1(GOOGLE_WORKSPACE_SCHEMA);
    expect(() =>
      createD1FileIndexingStore(db, { ...GOOGLE_WORKSPACE_STORE_CONFIG, cursorColumn: 'page_token; DROP TABLE x' }),
    ).toThrow(/not a plain SQL identifier/);
  });
});

describe('createD1FileIndexingStore on the microsoft-365 schema', () => {
  it('scopes every read and write to the connection', async () => {
    const { store, scope, db } = await rig('delta');
    const other = { actor: ALICE, connectionId: 'conn-2' };
    await store.enable(other, { connectedEmail: 'alice@second.com', extra: { tenant_id: 't2' } });
    await store.recordSuccess(scope, 'delta:1', 1, 0);
    expect((await store.load(scope))!.cursor).toBe('delta:1');
    expect((await store.load(other))!.cursor).toBeNull();
    expect((await store.load(other))!.raw.tenant_id).toBe('t2');
    // microsoft-365 writes NULL in sprigr_agent_id on a user row.
    await store.enable({ actor: { platformUserId: 'u9', agentId: 'agt_9' }, connectionId: 'c9' }, { connectedEmail: null });
    expect(db.all('SELECT sprigr_agent_id FROM ms_file_indexing WHERE sprigr_user_id = ?', 'u9')).toEqual([{ sprigr_agent_id: null }]);
    await expect(store.load({ actor: ALICE })).rejects.toThrow(/needs a connectionId/);
    const listed = await store.listEnabled();
    expect(listed.map((l) => l.scope.connectionId).sort()).toEqual(['c9', 'conn-1', 'conn-2']);
  });

  it('reads and writes the re-stamp columns', async () => {
    const { store, scope } = await rig('delta');
    expect(store.hasAclRefreshColumns).toBe(true);
    expect(store.hasWalkResumeColumns).toBe(false);
    await store.setAclRefresh(scope, 'link-2', null);
    expect((await store.load(scope))!).toMatchObject({ acl_refresh_link: 'link-2', acl_refresh_completed_at: null });
    await expect(store.recordWalkProgress(scope, { listToken: null, startToken: null, indexed: 0, skipped: 0 })).rejects.toThrow(
      /walkResumeColumns/,
    );
  });
});

describe('defaultRedact', () => {
  it('masks bearer tokens and secret-shaped values', () => {
    const out = defaultRedact('Bearer eyJabc.def {"refresh_token":"r1","client_secret": "s"} password=hunter2');
    expect(out).not.toMatch(/eyJabc|r1|hunter2/);
    expect(out).toContain('[redacted]');
  });
});
