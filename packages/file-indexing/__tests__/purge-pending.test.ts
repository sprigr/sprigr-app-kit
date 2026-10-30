/**
 * sprigr-app-kit#96: a disconnect purge that cannot finish in one call is
 * queued and finished by later ticks, without the person running the
 * disconnect again, and never at the cost of rows that are no longer theirs.
 */
import { describe, expect, it } from 'vitest';
import { drainPendingPurges, indexActorFiles, purgeActor } from '../src/indexer';
import { drainPendingExtractions } from '../src/pending';
import { BOB, rig, seedFiles } from './helpers/setup';

const cut = { deadline: { at: 2000 }, now: () => 0 };

describe('sprigr-app-kit#96: pending purges', () => {
  it.each(['delta', 'dropbox'] as const)('%s: a cut purge is queued, and a later drain finishes and dequeues it', async (kind) => {
    const r = await rig(kind);
    seedFiles(r.src, 3);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    const before = r.fp.acl.size;

    const res = await purgeActor(r.adapter, r.store, r.fp.env, r.scope, cut);
    expect(res).toMatchObject({ complete: false, removed: 0 });
    expect(res.queued).toEqual(res.prefixes);
    expect(r.fp.acl.size).toBe(before);
    // Not an extraction job: the extraction drain never sees it.
    expect(await r.store.listPendingExtractions(10)).toEqual([]);
    expect(await drainPendingExtractions(r.store, r.fp.env)).toBe(0);

    const d = await drainPendingPurges(r.store, r.fp.env);
    expect(d).toMatchObject({ purged: 1, removed: before, dropped: 0, remaining: 0, errors: [] });
    expect(r.fp.acl.size).toBe(0);
    expect(await drainPendingPurges(r.store, r.fp.env)).toMatchObject({ purged: 0, removed: 0 });
  });

  it('a person who reconnected before the drain keeps their rows', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 2);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    await purgeActor(r.adapter, r.store, r.fp.env, r.scope, cut);
    await r.store.enable(r.scope, { connectedEmail: 'alice@corp.com' });

    const d = await drainPendingPurges(r.store, r.fp.env);
    expect(d).toMatchObject({ purged: 0, removed: 0, dropped: 1 });
    expect(r.fp.acl.size).toBe(2);
    expect(await drainPendingPurges(r.store, r.fp.env)).toMatchObject({ dropped: 0 });
  });

  it('install-wide ids: dropped, not purged, once another actor indexes under the prefix', async () => {
    const r = await rig('drive');
    seedFiles(r.src, 2);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    const res = await purgeActor(r.adapter, r.store, r.fp.env, r.scope, cut);
    expect(res.queued).toEqual(['gw:file:']);
    await r.store.enable({ actor: BOB }, { connectedEmail: 'bob@corp.com' });

    const d = await drainPendingPurges(r.store, r.fp.env);
    expect(d).toMatchObject({ purged: 0, dropped: 1 });
    expect(r.fp.acl.size).toBe(2);
    expect(r.fp.deletes).toEqual([]);
  });

  it('a drain with no time left starts nothing and keeps the queue', async () => {
    const r = await rig('delta');
    seedFiles(r.src, 2);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    await purgeActor(r.adapter, r.store, r.fp.env, r.scope, cut);
    expect(await drainPendingPurges(r.store, r.fp.env, cut)).toMatchObject({ purged: 0, remaining: 1 });
    expect(await drainPendingPurges(r.store, r.fp.env)).toMatchObject({ purged: 1, removed: 2 });
  });

  it('a skipped purge is not queued', async () => {
    const r = await rig('drive');
    seedFiles(r.src, 2);
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    await r.store.enable({ actor: BOB }, { connectedEmail: 'bob@corp.com' });
    const res = await purgeActor(r.adapter, r.store, r.fp.env, r.scope, cut);
    expect(res).toMatchObject({ purgeSkipped: 'shared_prefix', queued: [] });
    expect(await drainPendingPurges(r.store, r.fp.env)).toMatchObject({ purged: 0, dropped: 0, remaining: 0 });
  });
});
