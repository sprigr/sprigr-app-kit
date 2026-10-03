/**
 * sprigr-apps#2521: emission used to stop at 50 events per run and drop the
 * rest while the cursor moved past them. Now every event goes out, and when
 * the emission slice runs out the cursor holds at the first page whose events
 * were not attempted.
 */
import { describe, expect, it } from 'vitest';
import { emitFileEvents } from '../src/events';
import { indexActorFiles } from '../src/indexer';
import { rig, seedFiles } from './helpers/setup';

describe('sprigr-apps#2521: no per-run event cap', () => {
  it('emits all 120 changes of one incremental run', async () => {
    const r = await rig('drive');
    r.src.pageSize = 100;
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    seedFiles(r.src, 120);
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(out.indexed).toBe(120);
    expect(out.eventsEmitted).toBe(120);
    expect(r.fp.emitted.length).toBe(120);
    expect(new Set(r.fp.emitted.map((e) => e.payload.objectID)).size).toBe(120);
  });

  it('holds the cursor at the first page whose events the slice could not reach', async () => {
    const r = await rig('drive');
    await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope); // empty drive: cursor chg:0
    seedFiles(r.src, 6); // three pages of two
    let t = 0;
    r.fp.env.SPRIGR!.emit = async (name: string, payload: unknown) => {
      t += 300; // each emit costs 300 ms of the 1000 ms slice
      r.fp.emitted.push({ name, payload: payload as Record<string, unknown> });
    };
    const out = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope, { now: () => t, emitBudgetMs: 1000 });
    expect(out.held).toBe(true);
    expect(out.eventsEmitted).toBe(4);
    expect((await r.store.load(r.scope))!.cursor).toBe('chg:4');
    const next = await indexActorFiles(r.adapter, r.store, r.fp.env, r.scope);
    expect(next.eventsEmitted).toBe(2);
    expect(r.fp.emitted.map((e) => e.payload.objectID).slice(-2)).toEqual(['gw:file:f05', 'gw:file:f06']);
    expect((await r.store.load(r.scope))!.cursor).toBe('chg:6');
  });

  it('emitFileEvents keeps going past a failed emit and reports the page it stopped at', async () => {
    const r = await rig('drive');
    const events = Array.from({ length: 5 }, (_, i) => ({ name: i === 1 ? 'bad' : 'ok', payload: { i }, page: i < 3 ? 0 : 1 }));
    r.fp.emitFailFor.add('bad');
    const outcome = await emitFileEvents(r.fp.env, events);
    expect(outcome).toEqual({ emitted: 4, failed: 1, suppressed: 0, firstUnattemptedPage: null });
    const cut = await emitFileEvents(r.fp.env, events, { deadline: { at: 0 }, now: () => 1 });
    expect(cut.firstUnattemptedPage).toBe(0);
  });
});
