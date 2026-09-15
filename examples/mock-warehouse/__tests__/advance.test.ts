/**
 * The half of the app the conformance harness cannot reach: the shakedown
 * lever, and the idempotency record underneath push_order.
 *
 * The carrier-scan levers get their own blocks. Those two are the ONLY way
 * a shakedown reaches the hub's provider.shipment.event handler, so what
 * they emit - the sequence, the dedup refs, the refusal before ship - is
 * asserted here rather than left to a live run.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { advance, cancelOrder, getOrderStatus, pushOrder } from '../src/handlers/provider';
import { freshDeps } from '../src/lib/deps';
import { fakeEnv } from './__helpers__/fake-env';

const push = (id: string) => ({
  fulfilment_request_id: id,
  order_id: 'ord_1',
  warehouse_key: 'mw_bne',
  lines: [{ line_id: 'ln_1', sku: 'CONF-SKU-1', quantity: 2 }],
});

describe('push_order', () => {
  it('mints a deterministic provider_ref and queues the request', async () => {
    const deps = freshDeps(() => '2026-09-15T00:00:00Z');
    const ack = await pushOrder(deps, push('fr_1'));
    expect(ack).toEqual({ status: 'queued', provider_ref: 'mw_fr_1' });
    expect(deps.vendor.calls).toBe(1);
    expect((await deps.store.get('fr_1'))?.stage).toBe('queued');
  });

  it('serves a repeat push from the record without touching the vendor', async () => {
    const deps = freshDeps();
    await pushOrder(deps, push('fr_1'));
    const again = await pushOrder(deps, push('fr_1'));
    expect(again).toEqual({ status: 'queued', provider_ref: 'mw_fr_1' });
    expect(deps.vendor.calls).toBe(1);
  });

  it('rejects an unknown warehouse with a reason rather than accepting into the void', async () => {
    const deps = freshDeps();
    const ack = await pushOrder(deps, { ...push('fr_1'), warehouse_key: 'mw_nowhere' });
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toContain('mw_nowhere');
    expect(deps.vendor.calls).toBe(0);
  });
});

describe('mock_warehouse_advance', () => {
  let env: ReturnType<typeof fakeEnv>;
  let deps: ReturnType<typeof freshDeps>;

  beforeEach(async () => {
    env = fakeEnv();
    deps = freshDeps(() => '2026-09-15T00:00:00Z');
    await pushOrder(deps, push('fr_1'));
  });

  it('emits accepted then shipment.created, in that order, from one call', async () => {
    const result = await advance(env, deps, { fulfilment_request_id: 'fr_1' });
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('shipped');
    expect(env.recorded.map((e) => e.event)).toEqual([
      'provider.order.accepted',
      'provider.shipment.created',
    ]);
    const shipment = env.recorded[1]!.payload.shipment as Record<string, unknown>;
    expect(shipment.carrier).toBe('Mock Carrier');
    expect(shipment.tracking_number).toBe('MWTRKFR1');
    expect(shipment.shipped_at).toBe('2026-09-15T00:00:00Z');
  });

  it('stamps every payload with adapter_slug and interface_version so the hub can attribute the row', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1' });
    for (const { payload } of env.recorded) {
      expect(payload.adapter_slug).toBe('mock-warehouse');
      expect(payload.interface_version).toBe('1.0.0');
      expect(payload.fulfilment_request_id).toBe('fr_1');
      expect(payload.provider_ref).toBe('mw_fr_1');
    }
  });

  it('stops at accepted when asked, and ships on a later call', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'accept' });
    expect(env.recorded.map((e) => e.event)).toEqual(['provider.order.accepted']);
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship', carrier: 'DHL', tracking_number: 'D1' });
    expect(env.recorded.map((e) => e.event)).toEqual([
      'provider.order.accepted',
      'provider.shipment.created',
    ]);
    expect(await getOrderStatus(deps, { fulfilment_request_id: 'fr_1' })).toMatchObject({
      status: 'shipped',
      tracking: { carrier: 'DHL', tracking_number: 'D1' },
    });
  });

  it('emits provider.order.cancelled on a cancel advance', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'cancel' });
    expect(env.recorded.map((e) => e.event)).toEqual(['provider.order.cancelled']);
  });

  it('reports a miss instead of throwing when the request is unknown', async () => {
    const result = await advance(env, deps, { fulfilment_request_id: 'nope' });
    expect(result).toEqual({ ok: false, reason: 'no request nope' });
    expect(env.recorded).toHaveLength(0);
  });

  it('records a failed emit rather than turning an ack into an exception', async () => {
    const hostile = { SPRIGR: { emit: async () => { throw new Error('is not available in sprigr app dev'); } } };
    const result = await advance(hostile, deps, { fulfilment_request_id: 'fr_1', to: 'accept' });
    expect(result.ok).toBe(true);
    expect(result.emitted?.[0]).toMatchObject({ event: 'provider.order.accepted', emitted: false });
  });
});

describe('mock_warehouse_advance to=scan', () => {
  let env: ReturnType<typeof fakeEnv>;
  let deps: ReturnType<typeof freshDeps>;

  beforeEach(async () => {
    env = fakeEnv();
    deps = freshDeps(() => '2026-09-15T00:00:00Z');
    await pushOrder(deps, push('fr_1'));
  });

  it('refuses before the request has shipped, rather than emitting a scan the hub cannot place', async () => {
    const result = await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'scan' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('has not shipped');
    expect(env.recorded).toHaveLength(0);
  });

  it('emits one provider.shipment.event on the request shipment, defaulting to departed_warehouse', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    env.recorded.length = 0;

    const result = await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'scan' });
    expect(result.ok).toBe(true);
    expect(env.recorded.map((e) => e.event)).toEqual(['provider.shipment.event']);
    expect(env.recorded[0]!.payload).toEqual({
      adapter_slug: 'mock-warehouse',
      interface_version: '1.0.0',
      fulfilment_request_id: 'fr_1',
      provider_ref: 'mw_fr_1',
      provider_shipment_ref: 'mws_fr_1',
      tracking_number: 'MWTRKFR1',
      stage: 'departed_warehouse',
      occurred_at: '2026-09-15T00:00:00.000Z',
      provider_event_ref: 'mwe_fr_1_departed_warehouse_1',
      location: 'Mock Warehouse',
    });
  });

  it('carries the caller stage, location and detail', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    env.recorded.length = 0;

    await advance(env, deps, {
      fulfilment_request_id: 'fr_1',
      to: 'scan',
      stage: 'exception',
      location: 'Sydney sort centre',
      detail: 'Held for address check',
    });
    expect(env.recorded[0]!.payload).toMatchObject({
      stage: 'exception',
      location: 'Sydney sort centre',
      detail: 'Held for address check',
      provider_event_ref: 'mwe_fr_1_exception_1',
    });
  });

  it('gives a repeat scan of the same stage a new ref, so the hub does not dedup it away', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'scan', stage: 'first_scan' });
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'scan', stage: 'first_scan' });

    const refs = env.recorded
      .filter((e) => e.event === 'provider.shipment.event')
      .map((e) => e.payload.provider_event_ref);
    expect(refs).toEqual(['mwe_fr_1_first_scan_1', 'mwe_fr_1_first_scan_2']);
  });

  it('refuses an unknown stage with the enum in the reason', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    env.recorded.length = 0;

    const result = await advance(env, deps, {
      fulfilment_request_id: 'fr_1',
      to: 'scan',
      stage: 'left_on_porch' as never,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('left_on_porch');
    expect(result.reason).toContain('destination_arrival');
    expect(env.recorded).toHaveLength(0);
  });

  it('keeps the history on the one row rather than writing a row per event', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'scan' });
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'scan', stage: 'first_scan' });

    const row = await deps.store.get('fr_1');
    const scans = JSON.parse(row!.scans_json) as Array<{ stage: string; provider_event_ref: string }>;
    expect(scans.map((s) => s.stage)).toEqual(['departed_warehouse', 'first_scan']);
    expect(row!.stage).toBe('shipped');
    expect(row!.delivered_at).toBe('');
  });
});

describe('mock_warehouse_advance to=deliver', () => {
  let env: ReturnType<typeof fakeEnv>;
  let deps: ReturnType<typeof freshDeps>;

  beforeEach(async () => {
    env = fakeEnv();
    deps = freshDeps(() => '2026-09-15T00:00:00Z');
    await pushOrder(deps, push('fr_1'));
  });

  it('refuses a request that has not shipped', async () => {
    const result = await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'deliver' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('has not shipped');
    expect(env.recorded).toHaveLength(0);
  });

  it('emits the four carrier scans in order, with ordered stamps and their own refs', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    env.recorded.length = 0;

    const result = await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'deliver' });
    expect(result.ok).toBe(true);
    expect(env.recorded.map((e) => e.event)).toEqual([
      'provider.shipment.event',
      'provider.shipment.event',
      'provider.shipment.event',
      'provider.shipment.event',
    ]);
    expect(env.recorded.map((e) => e.payload.stage)).toEqual([
      'departed_warehouse',
      'first_scan',
      'destination_arrival',
      'delivered',
    ]);
    expect(env.recorded.map((e) => e.payload.provider_event_ref)).toEqual([
      'mwe_fr_1_departed_warehouse_1',
      'mwe_fr_1_first_scan_1',
      'mwe_fr_1_destination_arrival_1',
      'mwe_fr_1_delivered_1',
    ]);
    expect(env.recorded.map((e) => e.payload.occurred_at)).toEqual([
      '2026-09-14T23:59:57.000Z',
      '2026-09-14T23:59:58.000Z',
      '2026-09-14T23:59:59.000Z',
      '2026-09-15T00:00:00.000Z',
    ]);
    for (const { payload } of env.recorded) {
      expect(payload.provider_shipment_ref).toBe('mws_fr_1');
      expect(payload.tracking_number).toBe('MWTRKFR1');
      expect(String(payload.occurred_at).endsWith('Z')).toBe(true);
    }
  });

  it('records the delivery on the request row and reports it through get_order_status', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship', carrier: 'DHL', tracking_number: 'D1' });
    const result = await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'deliver' });

    expect(result.stage).toBe('delivered');
    expect(result.delivered_at).toBe('2026-09-15T00:00:00.000Z');
    expect(result.scans?.map((s) => s.stage)).toEqual([
      'departed_warehouse',
      'first_scan',
      'destination_arrival',
      'delivered',
    ]);

    const row = await deps.store.get('fr_1');
    expect(row!.stage).toBe('delivered');
    expect(row!.delivered_at).toBe('2026-09-15T00:00:00.000Z');
    expect(JSON.parse(row!.scans_json)).toHaveLength(4);

    expect(await getOrderStatus(deps, { fulfilment_request_id: 'fr_1' })).toMatchObject({
      status: 'delivered',
      tracking: { carrier: 'DHL', tracking_number: 'D1' },
    });
  });

  it('continues the ref sequence when a stage was already scanned by hand', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'scan' });
    env.recorded.length = 0;

    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'deliver' });
    expect(env.recorded.map((e) => e.payload.provider_event_ref)).toEqual([
      'mwe_fr_1_departed_warehouse_2',
      'mwe_fr_1_first_scan_1',
      'mwe_fr_1_destination_arrival_1',
      'mwe_fr_1_delivered_1',
    ]);
    expect(JSON.parse((await deps.store.get('fr_1'))!.scans_json)).toHaveLength(5);
  });

  it('refuses to cancel a delivered request, and says so on the wire', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'deliver' });
    env.recorded.length = 0;

    const ack = await cancelOrder(env, deps, { fulfilment_request_id: 'fr_1' });
    expect(ack).toEqual({ status: 'rejected', reason: 'already delivered' });
    expect(env.recorded.map((e) => e.event)).toEqual(['provider.order.cancel_refused']);
    expect(env.recorded[0]!.payload.reason).toBe('already delivered');
  });

  it('records a failed emit rather than turning the lever into an exception', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    const hostile = { SPRIGR: { emit: async () => { throw new Error('is not available in sprigr app dev'); } } };
    const result = await advance(hostile, deps, { fulfilment_request_id: 'fr_1', to: 'deliver' });
    expect(result.ok).toBe(true);
    expect(result.emitted).toHaveLength(4);
    expect(result.emitted?.every((e) => e.emitted === false)).toBe(true);
  });
});

/**
 * The cancel outcome, which the hub learns ONLY from an event.
 *
 * Measured on staging 2026-09-15 23:09Z: the hub called cancel_order, got
 * `accepted`, the mock's row moved to cancelled, and the hub's own request
 * sat at `pushed` under a cancelled order forever, because the only emit was
 * behind the advance lever and nothing advances a cancelled request.
 */
describe('mock_warehouse_cancel_order', () => {
  let env: ReturnType<typeof fakeEnv>;
  let deps: ReturnType<typeof freshDeps>;

  beforeEach(async () => {
    env = fakeEnv();
    deps = freshDeps(() => '2026-09-15T00:00:00Z');
    await pushOrder(deps, push('fr_1'));
  });

  it('emits provider.order.cancelled from the op, not from a later advance', async () => {
    const ack = await cancelOrder(env, deps, { fulfilment_request_id: 'fr_1', reason: 'customer changed mind' });
    expect(ack).toEqual({ status: 'accepted' });
    expect(env.recorded.map((e) => e.event)).toEqual(['provider.order.cancelled']);
    expect(env.recorded[0]!.payload).toEqual({
      adapter_slug: 'mock-warehouse',
      interface_version: '1.0.0',
      fulfilment_request_id: 'fr_1',
      provider_ref: 'mw_fr_1',
    });
    expect((await deps.store.get('fr_1'))?.stage).toBe('cancelled');
  });

  it('emits provider.order.cancel_refused with the reason when the request has shipped', async () => {
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'ship' });
    env.recorded.length = 0;

    const ack = await cancelOrder(env, deps, { fulfilment_request_id: 'fr_1' });
    expect(ack).toEqual({ status: 'rejected', reason: 'already shipped' });
    expect(env.recorded.map((e) => e.event)).toEqual(['provider.order.cancel_refused']);
    expect(env.recorded[0]!.payload).toEqual({
      adapter_slug: 'mock-warehouse',
      interface_version: '1.0.0',
      fulfilment_request_id: 'fr_1',
      provider_ref: 'mw_fr_1',
      reason: 'already shipped',
    });
    expect((await deps.store.get('fr_1'))?.stage).toBe('shipped');
  });

  it('refuses an unknown request without an event, having nothing to attribute it to', async () => {
    const ack = await cancelOrder(env, deps, { fulfilment_request_id: 'nope' });
    expect(ack).toEqual({ status: 'rejected', reason: 'no request nope' });
    expect(env.recorded).toHaveLength(0);
  });

  it('records a failed emit rather than turning the ack into an exception', async () => {
    const hostile = { SPRIGR: { emit: async () => { throw new Error('is not available in sprigr app dev'); } } };
    const ack = await cancelOrder(hostile, deps, { fulfilment_request_id: 'fr_1' });
    expect(ack).toEqual({ status: 'accepted' });
    expect((await deps.store.get('fr_1'))?.stage).toBe('cancelled');
  });

  it('does not emit a second time when the advance lever follows the op', async () => {
    await cancelOrder(env, deps, { fulfilment_request_id: 'fr_1' });
    const result = await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'cancel' });

    expect(result).toMatchObject({ ok: true, stage: 'cancelled', emitted: [] });
    expect(env.recorded.map((e) => e.event)).toEqual(['provider.order.cancelled']);
  });

  it('still lets the advance lever emit the outcome for a request cancelled some other way', async () => {
    const result = await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'cancel' });
    expect(result.emitted?.map((e) => e.event)).toEqual(['provider.order.cancelled']);
    expect(env.recorded.map((e) => e.event)).toEqual(['provider.order.cancelled']);

    // And a second lever call on the now-cancelled row stays quiet.
    await advance(env, deps, { fulfilment_request_id: 'fr_1', to: 'cancel' });
    expect(env.recorded.map((e) => e.event)).toEqual(['provider.order.cancelled']);
  });
});
