/**
 * sprigr-apps#2355 (disconnect purge) and sprigr-apps#2211 (permission
 * re-stamp for sources whose delta omits sharing-only changes).
 */
import { describe, expect, it } from 'vitest';
import { indexActorFiles, purgeActor, purgeIndexPrefix, refreshAclPrincipals } from '../src/indexer';
import { BOB, rig, seedFiles } from './helpers/setup';

const K = 'u:user_alice';
const oid = (id: string) => `ms:file:${K}:drive-1:${id}`;

describe('sprigr-apps#2355: purgeActor', () => {
  it('switches indexing off, unlinks the owner, and deletes only this actor rows (actor-scoped ids)', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 3);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    r.fp.acl.set('ms:file:u:user_bob:drive-9:x', { objectID: 'ms:file:u:user_bob:drive-9:x', acl_principals: ['user:bob@corp.com'] });
    await r.store.upsertPendingExtraction({ objectId: oid('f01'), jobToken: 'j', recordJson: '{}', format: 'pptx' });
    await r.store.recordWalkSeen(r.store.walkKey(r.scope), [oid('f01')]);

    const res = await purgeActor(r.adapter, r.store, r.fp.env, r.scope);
    expect(res).toMatchObject({ disabled: true, unlinked: true, removed: 3, complete: true, errors: [] });
    expect(res.prefixes).toEqual([`ms:file:${K}:`]);
    expect([...r.fp.acl.keys()]).toEqual(['ms:file:u:user_bob:drive-9:x']);
    expect(await r.store.listPendingExtractions(5)).toEqual([]);
    expect(await r.store.listWalkSeen(r.store.walkKey(r.scope))).toEqual([]);
    expect(r.fp.links.at(-1)).toEqual({ op: 'unlink', owner: { kind: 'user', id: 'user_alice' }, email: 'alice@corp.com' });
    const row = (await r.store.load(r.scope))!;
    expect(row.enabled).toBe(0); // kept as the opt-out tombstone

    // A tick after the disconnect indexes nothing.
    r.src.put({ id: 'late', name: 'late.txt', mime: 'text/plain', perms: [] });
    expect((await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope)).indexed).toBe(0);
    expect(r.fp.acl.size).toBe(1);
  });

  it('reports an incomplete purge when the deadline leaves no room, so the caller can queue the rest', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 2);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    const res = await purgeActor(r.adapter, r.store, r.fp.env, r.scope, { deadline: { at: 2000 }, now: () => 0 });
    expect(res).toMatchObject({ disabled: true, removed: 0, complete: false });
    expect(r.fp.acl.size).toBe(2);
    const again = await purgeIndexPrefix(r.fp.env, r.store, `ms:file:${K}:`);
    expect(again).toEqual({ removed: 2, complete: true, truncated: false, cut: false });
  });

  it('install-scoped ids: purges when this actor is the only indexer, refuses to guess when others index', async () => {
    const solo = await rig('drive');
    seedFiles(solo.src, 2);
    await indexActorFiles(solo.adapter, solo.store, solo.fp.env, solo.scope);
    const a = await purgeActor(solo.adapter, solo.store, solo.fp.env, solo.scope);
    expect(a).toMatchObject({ disabled: true, removed: 2, complete: true });
    expect(solo.fp.links.at(-1)).toEqual({ op: 'unlink', owner: { kind: 'user', id: 'user_alice' } });

    const shared = await rig('drive');
    seedFiles(shared.src, 2);
    await indexActorFiles(shared.adapter, shared.store, shared.fp.env, shared.scope);
    await shared.store.enable({ actor: BOB }, { connectedEmail: 'bob@corp.com' });
    const b = await purgeActor(shared.adapter, shared.store, shared.fp.env, shared.scope);
    expect(b).toMatchObject({ disabled: true, unlinked: true, removed: 0, complete: false, purgeSkipped: 'shared_prefix' });
    expect(shared.fp.acl.size).toBe(2);
  });

  it('install-scoped ids: an actor with NO indexing row purges nothing, even when no one else indexes', async () => {
    // Regression: with no row and no other actor, countOtherActors is 0 and
    // the first cut deleted the whole install's `gw:file:` prefix.
    const r = await rig('drive');
    seedFiles(r.src, 3);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    await r.store.remove(r.scope); // the table is now empty
    const res = await purgeActor(r.adapter, r.store, r.fp.env, r.scope);
    expect(res).toMatchObject({ disabled: false, removed: 0, complete: false, purgeSkipped: 'no_indexing_row', prefixes: [] });
    expect(r.fp.acl.size).toBe(3);
    expect(r.fp.deletes).toEqual([]);
    // Actor-scoped ids are unaffected: the prefix names the actor, so it is safe.
    const ms = await rig('delta');
    seedFiles(ms.src, 2);
    await indexActorFiles(ms.adapter, ms.store, ms.fp.env, ms.scope);
    await ms.store.remove(ms.scope);
    expect(await purgeActor(ms.adapter, ms.store, ms.fp.env, ms.scope, { email: 'alice@corp.com' })).toMatchObject({ removed: 2 });
  });

  it('never throws, and skips the purge without the list/delete surface', async () => {
    const r = await rig('delta', { platform: { withListIds: false } });
    const res = await purgeActor(r.adapter, r.store, r.fp.env, r.scope);
    expect(res).toMatchObject({ disabled: true, purgeSkipped: 'unavailable', complete: false });
    expect(await purgeActor(r.adapter, r.store, r.fp.env, { actor: {} })).toMatchObject({ purgeSkipped: 'no_actor_key' });
  });

  it('never unlinks every address for one connection whose address it does not know', async () => {
    const r = await rig('delta');
    const ghost = { actor: { platformUserId: 'user_alice' }, connectionId: 'never-enabled' };
    const res = await purgeActor(r.adapter, r.store, r.fp.env, ghost);
    expect(res.unlinked).toBe(false);
    expect(res.errors.join(' ')).toMatch(/identity link left in place/);
    expect(r.fp.links.filter((l) => l.op === 'unlink')).toEqual([]);
  });
});

describe('sprigr-app-kit#99: purgeIndexPrefix reports truncated, cut and error apart, and never throws', () => {
  const prefix = `ms:file:${K}:`;
  async function indexedRig(n: number) {
    const r = await rig('delta');
    seedFiles(r.src, n);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    return r;
  }
  /** The fake env with `data.listIds` / `data.delete` replaced. */
  function withData(r: Awaited<ReturnType<typeof indexedRig>>, patch: Record<string, unknown>) {
    const sprigr = r.fp.env.SPRIGR!;
    return { ...r.fp.env, SPRIGR: { ...sprigr, data: { ...sprigr.data!, ...patch } } };
  }

  it('a truncated listing is truncated, not cut', async () => {
    const r = await indexedRig(3);
    r.fp.listTruncated = true;
    expect(await purgeIndexPrefix(r.fp.env, r.store, prefix)).toEqual({ removed: 1, complete: false, truncated: true, cut: false });
  });

  it('a deadline stop is cut, not truncated', async () => {
    const r = await indexedRig(2);
    const out = await purgeIndexPrefix(r.fp.env, r.store, prefix, { deadline: { at: 2_000 }, now: () => 0 });
    expect(out).toEqual({ removed: 0, complete: false, truncated: false, cut: true });
    expect(r.fp.acl.size).toBe(2);
  });

  it('a delete that fails part-way returns the error AND the rows already removed (0.1.0 threw and lost them)', async () => {
    const r = await indexedRig(1);
    // 251 ids: two chunks of PURGE_DELETE_CHUNK (250). The second delete fails.
    for (let i = 0; i < 250; i++) {
      const id = `${prefix}drive-1:bulk-${String(i).padStart(3, '0')}`;
      r.fp.acl.set(id, { objectID: id, acl_principals: ['user:alice@corp.com'] });
    }
    const realDelete = r.fp.env.SPRIGR!.data!.delete!;
    let calls = 0;
    const env = withData(r, {
      async delete(ids: string[], o?: { withAcl?: boolean }) {
        if (++calls === 2) throw new Error('503 index busy');
        return realDelete(ids, o);
      },
    });
    const out = await purgeIndexPrefix(env, r.store, prefix);
    expect(out).toEqual({ removed: 250, complete: false, truncated: false, cut: false, error: '503 index busy' });
    expect(r.fp.acl.size).toBe(1);
  });

  it('a listing failure is an error with nothing removed, not a throw', async () => {
    const r = await indexedRig(2);
    const env = withData(r, {
      async listIds() {
        throw new Error('listIds exploded');
      },
    });
    expect(await purgeIndexPrefix(env, r.store, prefix)).toEqual({
      removed: 0,
      complete: false,
      truncated: false,
      cut: false,
      error: 'listIds exploded',
    });
  });

  it('the surface missing is unavailable, with truncated and cut false', async () => {
    const r = await rig('delta', { platform: { withListIds: false } });
    expect(await purgeIndexPrefix(r.fp.env, r.store, prefix)).toEqual({
      removed: 0,
      complete: false,
      truncated: false,
      cut: false,
      unavailable: true,
    });
  });

  it('purgeActor records a failed pass in errors (0.1.0 caught the throw; 0.1.1 reads error)', async () => {
    const r = await indexedRig(2);
    const realDelete = r.fp.env.SPRIGR!.data!.delete!;
    const env = withData(r, {
      async delete(ids: string[], o?: { withAcl?: boolean }) {
        await realDelete(ids, o);
        throw new Error('reply lost after the delete');
      },
    });
    const res = await purgeActor(r.adapter, r.store, env, r.scope);
    expect(res).toMatchObject({ disabled: true, removed: 0, complete: false });
    expect(res.errors).toEqual([`purge ${prefix}: reply lost after the delete`]);
  });
});

describe('sprigr-apps#2211: refreshAclPrincipals', () => {
  async function indexed() {
    const r = await rig('delta');
    seedFiles(r.src, 3);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    return r;
  }

  it('re-stamps a sharing-only change the delta never reported, keeping the row content', async () => {
    const r = await indexed();
    expect(r.fp.acl.get(oid('f02'))!.content).toBe('body 2');
    // Unshare f02 from bob with no change record (OneDrive omits it from delta).
    r.src.files.get('f02')!.perms = [];
    const out = await refreshAclPrincipals(r.adapter, r.store, r.fp.env, r.scope, { now: () => 5_000 });
    expect(out).toMatchObject({ pages: 2, restamped: 1, missing: 0, skipped: 0, completed: true });
    expect(r.fp.acl.get(oid('f02'))).toMatchObject({ acl_principals: ['user:alice@corp.com'], content: 'body 2' });
    expect((await r.store.load(r.scope))!).toMatchObject({ acl_refresh_link: null, acl_refresh_completed_at: 5_000 });
    // Not due again inside the interval.
    expect(await refreshAclPrincipals(r.adapter, r.store, r.fp.env, r.scope, { now: () => 6_000 })).toBeNull();
  });

  it('resumes from its own link across ticks and keeps a stamp it cannot re-read', async () => {
    const r = await indexed();
    r.src.failPerms.add('f01');
    const t1 = await refreshAclPrincipals(r.adapter, r.store, r.fp.env, r.scope, { maxPages: 1 });
    expect(t1).toMatchObject({ pages: 1, skipped: 1, completed: false });
    expect((await r.store.load(r.scope))!.acl_refresh_link).toBe('2');
    expect(r.fp.acl.get(oid('f01'))!.acl_principals).toEqual(['user:alice@corp.com', 'user:bob@corp.com']);
    const t2 = await refreshAclPrincipals(r.adapter, r.store, r.fp.env, r.scope);
    expect(t2).toMatchObject({ pages: 1, completed: true });
  });

  it('waits for headroom, never runs during a full walk, and is unavailable without the columns', async () => {
    const r = await indexed();
    expect(
      await refreshAclPrincipals(r.adapter, r.store, r.fp.env, r.scope, { deadline: { at: 5_000 }, now: () => 0 }),
    ).toMatchObject({ pages: 0, completed: false });
    await r.store.setFullWalkActive(r.scope, true);
    expect(await refreshAclPrincipals(r.adapter, r.store, r.fp.env, r.scope)).toBeNull();
    const gw = await rig('drive');
    expect(await refreshAclPrincipals({ ...gw.adapter, aclRefreshPage: async () => ({ entries: [], cursor: null, hasMore: false }) }, gw.store, gw.fp.env, gw.scope)).toBeNull();
  });

  it('refuses a reply that patched the plain index (a wrapper that dropped withAcl)', async () => {
    const r = await indexed();
    r.fp.partialUpdateIndex = 'comp_1-app-test';
    r.src.files.get('f01')!.perms = [];
    const out = await refreshAclPrincipals(r.adapter, r.store, r.fp.env, r.scope);
    expect(out!.error).toMatch(/acl-files/);
    expect((await r.store.load(r.scope))!.acl_refresh_completed_at).toBeNull();
  });

  it('sprigr-app-kit#99: runExclusive gets the env and deadline, tagged acl_refresh', async () => {
    const r = await indexed();
    const seen: unknown[] = [];
    const adapter = {
      ...r.adapter,
      async runExclusive<T>(_scope: unknown, walkKey: string, fn: () => Promise<T>, run: unknown) {
        seen.push({ walkKey, run });
        return { busy: false as const, value: await fn() };
      },
    };
    const now = () => 5_000;
    await refreshAclPrincipals(adapter, r.store, r.fp.env, r.scope, { deadline: { at: 900_000 }, now });
    expect(seen).toEqual([
      { walkKey: r.store.walkKey(r.scope), run: { env: r.fp.env, deadline: { at: 900_000 }, now, purpose: 'acl_refresh' } },
    ]);
  });

  it('counts rows the index does not hold as missing and never creates them', async () => {
    const r = await indexed();
    r.fp.acl.delete(oid('f03'));
    const out = await refreshAclPrincipals(r.adapter, r.store, r.fp.env, r.scope);
    expect(out!.missing).toBe(1);
    expect(r.fp.acl.has(oid('f03'))).toBe(false);
  });
});
