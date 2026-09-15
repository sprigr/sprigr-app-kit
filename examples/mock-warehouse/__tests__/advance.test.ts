/**
 * The half of the app the conformance harness cannot reach: the shakedown
 * lever, and the idempotency record underneath push_order.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { advance, getOrderStatus, pushOrder } from '../src/handlers/provider';
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
