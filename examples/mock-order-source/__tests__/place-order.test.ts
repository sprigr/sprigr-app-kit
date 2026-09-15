/**
 * The half the conformance harness cannot reach: the shakedown lever, the
 * event payloads the hub actually routes on, and the ops whose effect on the
 * store matters more than their ack.
 */
import { describe, expect, it } from 'vitest';
import {
  addNote,
  getOrder,
  hold,
  markShipped,
  placeOrder,
  release,
  setStockLevel,
  split,
} from '../src/handlers/order-source';
import { freshDeps } from '../src/lib/deps';
import { SEED_ORDER, SEED_REQUEST } from '../src/lib/records';
import { fakeEnv } from './__helpers__/fake-env';

const at = () => '2026-09-15T00:00:00Z';

describe('place_order', () => {
  it('emits order.created then request.submitted, with derived ids', async () => {
    const env = fakeEnv();
    const deps = freshDeps(at);
    const result = await placeOrder(env, deps, { source_number: 'MOS-2001', sku: 'CONF-SKU-9', quantity: 3 });

    expect(result).toMatchObject({
      ok: true,
      source_ref: 'mos_mos_2001',
      source_request_ref: 'mos_mos_2001_r1',
    });
    expect(env.recorded.map((e) => e.event)).toEqual([
      'source.order.created',
      'source.request.submitted',
    ]);
  });

  it('puts the canonical order shape on order.created, with integer money', async () => {
    const env = fakeEnv();
    await placeOrder(env, freshDeps(at), {
      source_number: 'MOS-2002',
      quantity: 2,
      unit_price_minor: 1999,
      currency: 'nzd',
    });
    const order = env.recorded[0]!.payload.order as Record<string, unknown>;
    expect(order).toMatchObject({
      order_id: '',
      source_adapter: 'mock-order-source',
      channel: 'mock',
      status: 'received',
      currency: 'NZD',
      total_minor: 3998,
      placed_at: '2026-09-15T00:00:00Z',
    });
    expect(Number.isInteger(order.total_minor)).toBe(true);
  });

  it('carries the routing fields the hub reads off request.submitted', async () => {
    const env = fakeEnv();
    await placeOrder(env, freshDeps(at), { source_number: 'MOS-2003', source_location_ref: 'mos_loc_syd' });
    expect(env.recorded[1]!.payload).toMatchObject({
      adapter_slug: 'mock-order-source',
      interface_version: '1.0.0',
      source_ref: 'mos_mos_2003',
      source_request_ref: 'mos_mos_2003_r1',
      source_location_ref: 'mos_loc_syd',
      lines: [{ source_line_ref: 'mos_mos_2003_l1', sku: 'CONF-SKU-1', quantity: 1 }],
    });
  });

  it('refuses a duplicate source_number rather than overwriting the order', async () => {
    const env = fakeEnv();
    const deps = freshDeps(at);
    await placeOrder(env, deps, { source_number: 'MOS-2004' });
    const again = await placeOrder(env, deps, { source_number: 'MOS-2004' });
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('already exists');
    expect(env.recorded).toHaveLength(2);
  });
});

describe('the seeded order', () => {
  it('answers get_order in the canonical shapes', async () => {
    const result = await getOrder(freshDeps(at), { source_ref: SEED_ORDER.source_ref });
    expect(result.found).toBe(true);
    expect(result.order).toMatchObject({ order_id: '', source_ref: 'mos_seed_1', source_number: 'MOS-1001' });
    expect(result.lines).toHaveLength(2);
    expect(result.lines?.[0]).toMatchObject({ source_line_ref: 'mos_seed_1_l1', quantity: 2, requires_shipping: true });
  });

  it('answers found:false for an id it does not know', async () => {
    expect(await getOrder(freshDeps(at), { source_ref: 'nope' })).toEqual({ found: false });
  });
});

describe('the request lifecycle', () => {
  it('hold marks the order held and release re-triggers routing', async () => {
    const env = fakeEnv();
    const deps = freshDeps(at);
    await hold(deps, { source_request_ref: SEED_REQUEST.source_request_ref, reason: 'backorder' });
    expect((await deps.store.getOrder(SEED_ORDER.source_ref))?.hold_reason).toBe('backorder');
    expect((await deps.store.getOrder(SEED_ORDER.source_ref))?.status).toBe('held');

    const ack = await release(env, deps, { source_request_ref: SEED_REQUEST.source_request_ref });
    expect(ack).toEqual({ status: 'accepted' });
    expect((await deps.store.getOrder(SEED_ORDER.source_ref))?.hold_reason).toBe('');
    expect(env.recorded.map((e) => e.event)).toEqual(['source.request.hold_released']);
  });

  it('acks release with error, not rejected, when the hub never hears the event', async () => {
    const deps = freshDeps(at);
    // An order source acks accepted | rejected | error: `error` says the hub
    // may retry, `rejected` says give up. A release the hub missed is the
    // first, and getting it wrong strands the request forever.
    const deaf = { SPRIGR: { emit: async () => { throw new Error('emit unavailable'); } } };
    const ack = await release(deaf, deps, { source_request_ref: SEED_REQUEST.source_request_ref });
    expect(ack.status).toBe('error');
    expect(ack.reason).toContain('did not reach the hub');
    // The release itself still happened; only the announcement failed.
    expect((await deps.store.getRequest(SEED_REQUEST.source_request_ref))?.state).toBe('submitted');
  });

  it('split moves the named lines to a new request and emits a fresh routing trigger', async () => {
    const env = fakeEnv();
    const deps = freshDeps(at);
    const ack = await split(env, deps, {
      source_request_ref: SEED_REQUEST.source_request_ref,
      lines: [{ source_line_ref: 'mos_seed_1_l2', quantity: 1 }],
    });
    expect(ack.status).toBe('accepted');
    const newRef = ack.new_source_request_ref!;
    expect(newRef).not.toBe(SEED_REQUEST.source_request_ref);

    const original = await deps.store.getRequest(SEED_REQUEST.source_request_ref);
    expect(JSON.parse(original!.lines_json)).toEqual([
      { source_line_ref: 'mos_seed_1_l1', sku: 'CONF-SKU-1', quantity: 2 },
    ]);
    const created = await deps.store.getRequest(newRef);
    expect(JSON.parse(created!.lines_json)).toEqual([
      { source_line_ref: 'mos_seed_1_l2', sku: 'CONF-SKU-2', quantity: 1 },
    ]);
    expect(env.recorded.map((e) => e.event)).toEqual(['source.request.submitted']);
    expect(env.recorded[0]!.payload.source_request_ref).toBe(newRef);
  });

  it('mark_shipped returns a source_fulfilment_ref and moves the order to shipped', async () => {
    const deps = freshDeps(at);
    const ack = await markShipped(deps, {
      source_request_ref: SEED_REQUEST.source_request_ref,
      source_ref: SEED_ORDER.source_ref,
      carrier: 'Mock Carrier',
      tracking_number: 'T1',
      lines: [{ source_line_ref: 'mos_seed_1_l1', quantity: 2 }],
    });
    expect(ack).toEqual({ status: 'accepted', source_fulfilment_ref: 'mos_sf_mos_seed_1_r1' });
    expect((await deps.store.getOrder(SEED_ORDER.source_ref))?.status).toBe('shipped');
  });

  it('mark_shipped refuses without tracking rather than writing a blank fulfilment', async () => {
    const deps = freshDeps(at);
    const ack = await markShipped(deps, {
      source_request_ref: SEED_REQUEST.source_request_ref,
      source_ref: SEED_ORDER.source_ref,
      carrier: '',
      tracking_number: '',
      lines: [],
    });
    expect(ack.status).toBe('rejected');
    expect((await deps.store.getRequest(SEED_REQUEST.source_request_ref))?.state).toBe('submitted');
  });
});

describe('stock and notes', () => {
  it('set_stock_level stores an integer and announces the change', async () => {
    const env = fakeEnv();
    const deps = freshDeps(at);
    const ack = await setStockLevel(env, deps, { source_location_ref: 'mos_loc_bne', sku: 'CONF-SKU-1', on_hand: 12 });
    expect(ack.status).toBe('accepted');
    expect(await deps.store.getStock('mos_loc_bne', 'CONF-SKU-1')).toMatchObject({ on_hand: 12 });
    expect(env.recorded[0]).toMatchObject({
      event: 'source.stock.changed',
      payload: { source_location_ref: 'mos_loc_bne', sku: 'CONF-SKU-1', on_hand: 12 },
    });
  });

  it('set_stock_level refuses a fractional quantity rather than rounding it', async () => {
    const env = fakeEnv();
    const deps = freshDeps(at);
    const ack = await setStockLevel(env, deps, { source_location_ref: 'mos_loc_bne', sku: 'S', on_hand: 1.5 });
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('integer');
    expect(await deps.store.getStock('mos_loc_bne', 'S')).toBeNull();
    expect(env.recorded).toHaveLength(0);
  });

  it('add_note appends and never replaces what is already on the order', async () => {
    const deps = freshDeps(at);
    await addNote(deps, { source_ref: SEED_ORDER.source_ref, note: 'first', tags: ['hub'] });
    await addNote(deps, { source_ref: SEED_ORDER.source_ref, note: 'second' });
    const order = await deps.store.getOrder(SEED_ORDER.source_ref);
    expect(JSON.parse(order!.notes_json).map((n: { note: string }) => n.note)).toEqual(['first', 'second']);
    expect(JSON.parse(order!.tags_json)).toEqual(['seed', 'hub']);
  });
});
