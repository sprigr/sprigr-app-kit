import { describe, expect, it } from 'vitest';
import { runFulfilmentProviderConformance } from '../src/fulfilment-provider';
import { formatReport } from '../src/report';
import { makeProviderAdapter } from './fixtures';

function failed(report: { checks: { name: string; ok: boolean }[] }): string[] {
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe('runFulfilmentProviderConformance', () => {
  it('passes a conforming adapter', async () => {
    const { handlers, vendor } = makeProviderAdapter();
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report), formatReport(report)).toEqual([]);
    expect(report.ok).toBe(true);
    // Three distinct requests, one of them pushed by two deliveries at once,
    // and one repeat: neither the repeat nor the second simultaneous delivery
    // may reach the vendor.
    expect(vendor.calls).toBe(3);
  });

  // update_ship_to is `optionalSince: '1.4.0'`: a provider written against
  // 1.3.0 has no handler for it and must stay conformant, and one that CLAIMS
  // the capability must actually implement it.
  it('leaves a pre-1.4.0 provider conformant: no update_ship_to handler, no capability, no failure', async () => {
    const { handlers, vendor } = makeProviderAdapter();
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toEqual([]);
    expect(report.checks.some((c) => c.name.startsWith('update_ship_to.'))).toBe(false);
  });

  it('fails a provider that claims supports_address_update and answers "unsupported"', async () => {
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_describe: () => ({
        adapter_slug: 'tiny-wh',
        capabilities: {
          supports_cancel: true,
          supports_split: false,
          supports_hold: false,
          supports_address_update: true,
          tracking_mode: 'push',
          stock_mode: 'snapshot',
          countries: ['AU'],
        },
      }),
      tiny_wh_update_ship_to: () => ({ status: 'rejected', reason: 'unsupported' }),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toEqual(['update_ship_to.matches_capability']);
  });

  it('passes a provider that claims supports_address_update and queues the change', async () => {
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_describe: () => ({
        adapter_slug: 'tiny-wh',
        capabilities: {
          supports_cancel: true,
          supports_split: false,
          supports_hold: false,
          supports_address_update: true,
          tracking_mode: 'push',
          stock_mode: 'snapshot',
          countries: ['AU'],
        },
      }),
      tiny_wh_update_ship_to: () => ({ status: 'queued', reason: 'emailed to the warehouse' }),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report), formatReport(report)).toEqual([]);
    expect(report.checks.some((c) => c.name === 'update_ship_to.matches_capability' && c.ok)).toBe(true);
  });

  // create_inbound is `optionalSince: '1.5.0'`: a provider written against
  // 1.4.0 has no handler for it and must stay conformant, and one that CLAIMS
  // supports_inbound must actually implement it.
  const inboundCaps = () => ({
    adapter_slug: 'tiny-wh',
    capabilities: {
      supports_cancel: true,
      supports_split: false,
      supports_hold: false,
      supports_inbound: true,
      tracking_mode: 'push',
      stock_mode: 'snapshot',
      countries: ['AU'],
    },
  });

  it('leaves a 1.4.0 provider conformant: no create_inbound handler, no capability, no failure', async () => {
    const { handlers, vendor } = makeProviderAdapter();
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toEqual([]);
    expect(report.checks.some((c) => c.name.startsWith('create_inbound.'))).toBe(false);
  });

  it('fails a provider that claims supports_inbound and answers "unsupported"', async () => {
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_describe: inboundCaps,
      tiny_wh_create_inbound: () => ({ status: 'rejected', reason: 'unsupported' }),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toEqual(['create_inbound.matches_capability']);
  });

  it('passes a provider that claims supports_inbound and queues the purchase order', async () => {
    let received: Record<string, unknown> | undefined;
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_describe: inboundCaps,
      tiny_wh_create_inbound: (args: never) => {
        received = args as unknown as Record<string, unknown>;
        return { status: 'queued', provider_ref: 'inb_ref_1', reason: 'emailed to the warehouse' };
      },
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report), formatReport(report)).toEqual([]);
    expect(report.checks.some((c) => c.name === 'create_inbound.matches_capability' && c.ok)).toBe(true);
    expect(received).toMatchObject({ inbound_id: expect.any(String), po_number: expect.any(String), warehouse_key: 'wh_a' });
  });

  it('fails when a repeat push_order reaches the vendor again', async () => {
    const vendor = { calls: 0 };
    let seq = 0;
    const { handlers } = makeProviderAdapter({
      tiny_wh_push_order: () => {
        vendor.calls += 1;
        seq += 1;
        return { status: 'accepted', provider_ref: `pr_${seq}` };
      },
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toContain('push_order.repeat_does_not_reach_vendor');
    expect(failed(report)).toContain('push_order.idempotent_provider_ref');
    expect(report.ok).toBe(false);
  });

  it('fails an adapter that reads before it pushes when two deliveries of one request arrive at once (#78)', async () => {
    // Passes the sequential repeat: the second push finds the first's record.
    // Two at once both read "not pushed" before either writes, and both reach
    // the vendor.
    const vendor = { calls: 0 };
    const pushed = new Map<string, string>();
    const { handlers } = makeProviderAdapter({
      tiny_wh_push_order: async (args: never) => {
        const id = (args as unknown as { fulfilment_request_id: string }).fulfilment_request_id;
        const existing = await Promise.resolve(pushed.get(id));
        if (existing) return { status: 'accepted', provider_ref: existing };
        vendor.calls += 1;
        const ref = await Promise.resolve(`pr_${id}`);
        pushed.set(id, ref);
        return { status: 'accepted', provider_ref: ref };
      },
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toEqual(['push_order.concurrent_repeat_reaches_vendor_once']);
  });

  it('passes a claim-first adapter whose losing delivery answers queued with no provider_ref yet', async () => {
    const vendor = { calls: 0 };
    const claims = new Map<string, string>();
    const { handlers } = makeProviderAdapter({
      tiny_wh_push_order: async (args: never) => {
        const id = (args as unknown as { fulfilment_request_id: string }).fulfilment_request_id;
        if (claims.has(id)) {
          const ref = await Promise.resolve(claims.get(id));
          return ref ? { status: 'queued', provider_ref: ref } : { status: 'queued' };
        }
        claims.set(id, '');
        vendor.calls += 1;
        const ref = await Promise.resolve(`pr_${id}`);
        claims.set(id, ref);
        return { status: 'queued', provider_ref: ref };
      },
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report), formatReport(report)).toEqual([]);
  });

  it('fails an adapter that never calls its vendor, rather than crediting it with idempotency', async () => {
    const { handlers } = makeProviderAdapter({
      tiny_wh_push_order: () => ({ status: 'accepted', provider_ref: 'pr_constant' }),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => 0,
    });
    expect(failed(report)).toContain('push_order.first_push_reaches_vendor');
    expect(failed(report)).toContain('push_order.distinct_request_distinct_ref');
  });

  it('fails when no vendorCalls hook is supplied', async () => {
    const { handlers } = makeProviderAdapter();
    const report = await runFulfilmentProviderConformance(handlers, { slug: 'tiny-wh', env: () => ({}) });
    expect(failed(report)).toContain('push_order.vendor_call_counted');
  });

  it('rejects a synchronous success value in place of an async ack', async () => {
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_push_order: () => ({ status: 'shipped', provider_ref: 'pr_1' }),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toContain('push_order.ack_status');
    expect(failed(report)).toContain('push_order.output_shape');
  });

  it('requires a reason on a rejected ack', async () => {
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_cancel_order: () => ({ status: 'rejected' }),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toEqual(['cancel_order.rejected_has_reason']);
  });

  it("refuses the ORDER SOURCE interface's error: a provider acks accepted | queued | rejected", async () => {
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_cancel_order: () => ({ status: 'error', reason: 'warehouse 503' }),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toEqual(['cancel_order.output_shape', 'cancel_order.ack_status']);
    expect(report.checks.find((c) => c.name === 'cancel_order.ack_status')?.detail).toContain(
      'accepted | queued | rejected',
    );
  });

  it('refuses a capability claim the behaviour contradicts', async () => {
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_describe: () => ({
        adapter_slug: 'tiny-wh',
        capabilities: {
          supports_cancel: false,
          supports_split: false,
          supports_hold: false,
          tracking_mode: 'poll',
          stock_mode: 'none',
          countries: [],
        },
      }),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    expect(failed(report)).toEqual(['cancel_order.matches_capability']);
  });

  it('fails a decimal stock level and a non-UTC snapshot stamp', async () => {
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_get_stock: () => ({
        levels: [
          {
            provider_adapter: 'tiny-wh',
            warehouse_key: 'wh_a',
            sku: 'S',
            on_hand: 1.5,
            reserved: 0,
            held: 0,
            snapshot_at: '2026-09-15T00:00:00+10:00',
          },
        ],
      }),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    const stock = report.checks.find((c) => c.name === 'get_stock.output_shape');
    expect(stock?.ok).toBe(false);
    expect(stock?.detail).toMatch(/on_hand must be an integer/);
    expect(stock?.detail).toMatch(/snapshot_at must be an ISO 8601 UTC/);
  });

  it('fails an op that blows the time budget instead of hanging on it', async () => {
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_health: () => new Promise(() => {}),
    });
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
      timeBudgetMs: 40,
    });
    expect(failed(report)).toEqual(['health.within_budget']);
  });

  it('fails a missing handler by its contract tool name', async () => {
    const { handlers, vendor } = makeProviderAdapter();
    delete handlers.tiny_wh_health;
    const report = await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => ({}),
      vendorCalls: () => vendor.calls,
    });
    const miss = report.checks.find((c) => c.name === 'health.invoked');
    expect(miss?.ok).toBe(false);
    expect(miss?.detail).toContain('tiny_wh_health');
  });

  it('passes the same env object to every op so idempotency state survives', async () => {
    const seen: unknown[] = [];
    const { handlers, vendor } = makeProviderAdapter({
      tiny_wh_health: (_args: never, env: never) => {
        seen.push(env);
        return { ok: true, credentials_ok: true, breaker_open: false };
      },
      tiny_wh_describe: (_args: never, env: never) => {
        seen.push(env);
        return {
          adapter_slug: 'tiny-wh',
          capabilities: {
            supports_cancel: true,
            supports_split: false,
            supports_hold: false,
            tracking_mode: 'push',
            stock_mode: 'snapshot',
            countries: ['AU'],
          },
        };
      },
    });
    let built = 0;
    await runFulfilmentProviderConformance(handlers, {
      slug: 'tiny-wh',
      env: () => {
        built += 1;
        return { marker: built };
      },
      vendorCalls: () => vendor.calls,
    });
    expect(built).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});
