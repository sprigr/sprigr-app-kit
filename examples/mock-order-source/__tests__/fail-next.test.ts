/**
 * The fault lever behind the hub's resend shakedown (sprigr-apps#3474): an
 * armed write op answers the retryable `error` ack, writes nothing, and runs
 * for real once its count is used up.
 */
import { describe, expect, it } from 'vitest';
import { addNote, failNext, markShipped } from '../src/handlers/order-source';
import { freshDeps } from '../src/lib/deps';
import { SEED_ORDER, SEED_REQUEST } from '../src/lib/records';

const at = () => '2026-10-29T00:00:00Z';

describe('fail_next', () => {
  it('fails add_note once with error, writes nothing, then accepts the resend', async () => {
    const deps = freshDeps(at);
    expect(await failNext(deps, { op: 'add_note' })).toEqual({ ok: true, op: 'add_note', count: 1 });

    const first = await addNote(deps, { source_ref: SEED_ORDER.source_ref, note: 'n1' });
    expect(first).toMatchObject({ status: 'error' });
    expect((await deps.store.getOrder(SEED_ORDER.source_ref))?.notes_json).toBe(SEED_ORDER.notes_json);

    expect(await addNote(deps, { source_ref: SEED_ORDER.source_ref, note: 'n1' })).toEqual({ status: 'accepted' });
  });

  it('fails mark_shipped for exactly count calls and leaves the request unshipped meanwhile', async () => {
    const deps = freshDeps(at);
    await failNext(deps, { op: 'mark_shipped', count: 2 });
    const args = {
      source_request_ref: SEED_REQUEST.source_request_ref,
      source_ref: SEED_ORDER.source_ref,
      carrier: 'AusPost',
      tracking_number: 'T1',
    };
    expect(await markShipped(deps, args)).toMatchObject({ status: 'error' });
    expect(await markShipped(deps, args)).toMatchObject({ status: 'error' });
    expect((await deps.store.getRequest(SEED_REQUEST.source_request_ref))?.state).toBe(SEED_REQUEST.state);
    expect(await markShipped(deps, args)).toMatchObject({ status: 'accepted' });
  });

  it('an armed op does not fail a different op, and count 0 disarms', async () => {
    const deps = freshDeps(at);
    await failNext(deps, { op: 'mark_shipped' });
    expect(await addNote(deps, { source_ref: SEED_ORDER.source_ref, note: 'x' })).toEqual({ status: 'accepted' });
    await failNext(deps, { op: 'mark_shipped', count: 0 });
    expect(
      await markShipped(deps, {
        source_request_ref: SEED_REQUEST.source_request_ref,
        source_ref: SEED_ORDER.source_ref,
        carrier: 'AusPost',
        tracking_number: 'T2',
      }),
    ).toMatchObject({ status: 'accepted' });
  });

  it('refuses an op outside the lever and a count out of range', async () => {
    const deps = freshDeps(at);
    expect(await failNext(deps, { op: 'cancel' })).toMatchObject({ ok: false });
    expect(await failNext(deps, { op: 'add_note', count: 6 })).toMatchObject({ ok: false });
    expect(await failNext(deps, { op: 'add_note', count: 1.5 })).toMatchObject({ ok: false });
  });
});
