/**
 * The inbound purchase order (fulfilment_provider 1.5.0) and its shakedown
 * lever.
 *
 * Without `create_inbound` the hub refuses every PO for this provider, so a
 * staging shakedown of the hub's PO and presale flow had nothing to drive.
 * The lever stands in for the warehouse's answer and its count, the same way
 * mock_warehouse_advance stands in for its order callbacks.
 *
 * Driven through the handler map the runtime dispatches, by name, because the
 * op name is what the hub binds.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import handlers from '../src/handlers/provider';
import manifest from '../sprigr-app.json';
import { fakeEnv, type FakeEnv } from './__helpers__/fake-env';

type Op = (args: Record<string, unknown>, env: FakeEnv) => Promise<Record<string, unknown>>;
const op = (name: string): Op => {
  const fn = (handlers as unknown as Record<string, Op | undefined>)[name];
  if (!fn) throw new Error(`the handler map has no ${name}`);
  return fn;
};

let seq = 0;
const po = (overrides: Record<string, unknown> = {}) => ({
  inbound_id: `inb_test_${++seq}`,
  po_number: `PO-${seq}`,
  warehouse_key: 'mw_bne',
  expected_arrival: '2026-12-01',
  lines: [
    { line_id: 'iln_1', sku: 'CONF-SKU-1', quantity: 10 },
    { line_id: 'iln_2', sku: 'CONF-SKU-2', quantity: 6 },
  ],
  ...overrides,
});

let env: FakeEnv;
beforeEach(() => {
  env = fakeEnv();
});

const emitted = (event: string) => env.recorded.filter((r) => r.event === event).map((r) => r.payload);

describe('create_inbound', () => {
  it('describe claims supports_inbound, so the hub sends POs here at all', () => {
    const d = (handlers as unknown as Record<string, () => { capabilities: Record<string, unknown> }>).mock_warehouse_describe();
    expect(d.capabilities.supports_inbound).toBe(true);
  });

  it('the manifest binds create_inbound at 1.5.0 to a handler', () => {
    const tools = (manifest as { cross_tenant_tools: Array<{ tool_name: string; provides?: { op: string; version: string } }> })
      .cross_tenant_tools;
    const bound = tools.find((t) => t.provides?.op === 'create_inbound');
    expect(bound?.provides?.version).toBe('1.5.0');
    expect(typeof (handlers as unknown as Record<string, unknown>)[bound!.tool_name]).toBe('function');
  });

  it('queues the PO under a deterministic ref and emits nothing until the lever', async () => {
    const args = po();
    const ack = await op('mock_warehouse_create_inbound')(args, env);
    expect(ack).toEqual({ status: 'queued', provider_ref: `mwi_${args.inbound_id}` });
    expect(env.recorded).toEqual([]);
  });

  it('is idempotent on inbound_id: the same id again is the same PO', async () => {
    const args = po();
    await op('mock_warehouse_create_inbound')(args, env);
    const again = await op('mock_warehouse_create_inbound')({ ...args, po_number: 'CHANGED' }, env);
    expect(again).toEqual({ status: 'queued', provider_ref: `mwi_${args.inbound_id}` });
    await op('mock_warehouse_inbound_advance')({ inbound_id: args.inbound_id, to: 'receive' }, env);
    const [received] = emitted('provider.inbound.received');
    // The first PO's lines, not a second one.
    expect(received?.lines).toHaveLength(2);
  });

  it('refuses an unknown warehouse, an empty PO and a non-positive quantity as an ack', async () => {
    const unknown = await op('mock_warehouse_create_inbound')(po({ warehouse_key: 'mw_nowhere' }), env);
    expect(unknown.status).toBe('rejected');
    expect(String(unknown.reason)).toContain('mw_nowhere');
    const empty = await op('mock_warehouse_create_inbound')(po({ lines: [] }), env);
    expect(empty.status).toBe('rejected');
    const zero = await op('mock_warehouse_create_inbound')(
      po({ lines: [{ line_id: 'iln_1', sku: 'CONF-SKU-1', quantity: 0 }] }),
      env,
    );
    expect(zero.status).toBe('rejected');
    expect(String(zero.reason)).toContain('CONF-SKU-1');
  });
});

describe('mock_warehouse_inbound_advance', () => {
  async function created() {
    const args = po();
    await op('mock_warehouse_create_inbound')(args, env);
    return args;
  }

  it('accept emits provider.inbound.accepted with the ref the hub stored', async () => {
    const args = await created();
    const r = await op('mock_warehouse_inbound_advance')({ inbound_id: args.inbound_id, to: 'accept' }, env);
    expect(r.ok).toBe(true);
    expect(emitted('provider.inbound.accepted')).toEqual([
      expect.objectContaining({ adapter_slug: 'mock-warehouse', inbound_id: args.inbound_id, provider_ref: `mwi_${args.inbound_id}` }),
    ]);
  });

  it('refuse emits provider.inbound.refused with the reason, and a refused PO takes no delivery', async () => {
    const args = await created();
    await op('mock_warehouse_inbound_advance')({ inbound_id: args.inbound_id, to: 'refuse', reason: 'dock full' }, env);
    expect(emitted('provider.inbound.refused')).toEqual([
      expect.objectContaining({ inbound_id: args.inbound_id, provider_ref: `mwi_${args.inbound_id}`, reason: 'dock full' }),
    ]);
    const r = await op('mock_warehouse_inbound_advance')({ inbound_id: args.inbound_id, to: 'receive' }, env);
    expect(r.ok).toBe(false);
    expect(emitted('provider.inbound.received')).toEqual([]);
  });

  it('a partial delivery reports cumulative counts, complete:false and delivery 1; the rest completes it as delivery 2', async () => {
    const args = await created();
    await op('mock_warehouse_inbound_advance')({ inbound_id: args.inbound_id, to: 'accept' }, env);
    await op('mock_warehouse_inbound_advance')(
      { inbound_id: args.inbound_id, to: 'receive', lines: [{ sku: 'CONF-SKU-2', quantity: 4 }] },
      env,
    );
    await op('mock_warehouse_inbound_advance')({ inbound_id: args.inbound_id, to: 'receive' }, env);

    const [first, second] = emitted('provider.inbound.received');
    expect(first).toMatchObject({ inbound_id: args.inbound_id, complete: false, delivery_count: 1 });
    expect(first?.lines).toEqual([
      { line_id: 'iln_1', sku: 'CONF-SKU-1', expected_quantity: 10, received_quantity: 0 },
      { line_id: 'iln_2', sku: 'CONF-SKU-2', expected_quantity: 6, received_quantity: 4 },
    ]);
    expect(second).toMatchObject({ complete: true, delivery_count: 2 });
    expect(second?.lines).toEqual([
      { line_id: 'iln_1', sku: 'CONF-SKU-1', expected_quantity: 10, received_quantity: 10 },
      { line_id: 'iln_2', sku: 'CONF-SKU-2', expected_quantity: 6, received_quantity: 6 },
    ]);
  });

  it('complete:true closes a short delivery, so a shakedown can drive a discrepancy', async () => {
    const args = await created();
    await op('mock_warehouse_inbound_advance')(
      { inbound_id: args.inbound_id, to: 'receive', lines: [{ sku: 'CONF-SKU-1', quantity: 7 }], complete: true },
      env,
    );
    const [only] = emitted('provider.inbound.received');
    expect(only).toMatchObject({ complete: true, delivery_count: 1 });
    expect(only?.lines).toEqual([
      { line_id: 'iln_1', sku: 'CONF-SKU-1', expected_quantity: 10, received_quantity: 7 },
      { line_id: 'iln_2', sku: 'CONF-SKU-2', expected_quantity: 6, received_quantity: 0 },
    ]);
    const after = await op('mock_warehouse_inbound_advance')({ inbound_id: args.inbound_id, to: 'receive' }, env);
    expect(after.ok).toBe(false);
  });

  it('answers an unknown PO or SKU with a reason rather than an event', async () => {
    const none = await op('mock_warehouse_inbound_advance')({ inbound_id: 'inb_missing', to: 'accept' }, env);
    expect(none.ok).toBe(false);
    const args = await created();
    const bad = await op('mock_warehouse_inbound_advance')(
      { inbound_id: args.inbound_id, to: 'receive', lines: [{ sku: 'NOT-ON-PO', quantity: 1 }] },
      env,
    );
    expect(bad.ok).toBe(false);
    expect(String(bad.reason)).toContain('NOT-ON-PO');
    expect(env.recorded).toEqual([]);
  });
});
