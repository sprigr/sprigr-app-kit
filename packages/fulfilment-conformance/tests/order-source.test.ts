import { describe, expect, it } from 'vitest';
import { runOrderSourceConformance } from '../src/order-source';
import { formatReport } from '../src/report';
import { makeOrderSourceAdapter } from './fixtures';

function failed(report: { checks: { name: string; ok: boolean }[] }): string[] {
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe('runOrderSourceConformance', () => {
  it('passes a conforming adapter', async () => {
    const { handlers } = makeOrderSourceAdapter();
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    expect(failed(report), formatReport(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('drives all thirteen contract ops', async () => {
    const called: string[] = [];
    const base = makeOrderSourceAdapter().handlers;
    const spied = Object.fromEntries(
      Object.entries(base).map(([name, fn]) => [
        name,
        (args: never, env: never) => {
          called.push(name);
          return fn(args, env);
        },
      ]),
    );
    await runOrderSourceConformance(spied, { slug: 'tiny-src', env: () => ({}) });
    expect(new Set(called).size).toBe(13);
  });

  it('fails a found:false get_order rather than quietly skipping the record shapes', async () => {
    const { handlers } = makeOrderSourceAdapter({ tiny_src_get_order: () => ({ found: false }) });
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    expect(failed(report)).toEqual(['get_order.resolves_the_fixture']);
  });

  it('uses an opts.fixtures override for the op it names', async () => {
    let seen = '';
    const { handlers } = makeOrderSourceAdapter({
      tiny_src_get_order: (args: never) => {
        seen = (args as unknown as { source_ref: string }).source_ref;
        return { found: false };
      },
    });
    await runOrderSourceConformance(handlers, {
      slug: 'tiny-src',
      env: () => ({}),
      fixtures: { get_order: { source_ref: 'shop_1001' } },
    });
    expect(seen).toBe('shop_1001');
  });

  it('fails a canonical order that carries decimal money or a local-offset stamp', async () => {
    const { handlers } = makeOrderSourceAdapter({
      tiny_src_get_order: () => ({
        found: true,
        order: {
          order_id: '',
          source_adapter: 'tiny-src',
          source_ref: 'src_conformance_order',
          source_number: 'PY1',
          channel: 'shopify',
          status: 'received',
          placed_at: '2026-09-15T10:00:00+10:00',
          currency: 'AUD',
          total_minor: 25.5,
          customer_email: '',
          ship_to_json: '{}',
          tags_json: '[]',
          hold_reason: '',
          updated_at: '2026-09-15T00:00:00Z',
        },
        lines: [],
      }),
    });
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    const shape = report.checks.find((c) => c.name === 'get_order.output_shape');
    expect(shape?.ok).toBe(false);
    expect(shape?.detail).toMatch(/total_minor must be an integer/);
    expect(shape?.detail).toMatch(/placed_at must be an ISO 8601 UTC/);
    expect(failed(report)).toContain('get_order.returns_lines');
  });

  it('rejects an order status outside the contract enum', async () => {
    const { handlers } = makeOrderSourceAdapter({
      tiny_src_get_order: () => ({ found: true, order: { status: 'in_transit' }, lines: [] }),
    });
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    const shape = report.checks.find((c) => c.name === 'get_order.output_shape');
    expect(shape?.detail).toMatch(/status must be one of received \| routing/);
  });

  it('rejects a write op that throws instead of acknowledging', async () => {
    const { handlers } = makeOrderSourceAdapter({
      tiny_src_hold: () => {
        throw new Error('shopify said no');
      },
    });
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    expect(failed(report)).toEqual(['hold.invoked']);
    expect(report.checks.find((c) => c.name === 'hold.invoked')?.detail).toContain('shopify said no');
  });

  it("refuses the PROVIDER interface's queued: an order source acks accepted | rejected | error", async () => {
    const { handlers } = makeOrderSourceAdapter({ tiny_src_hold: () => ({ status: 'queued' }) });
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    expect(failed(report)).toEqual(['hold.output_shape', 'hold.ack_status']);
    expect(report.checks.find((c) => c.name === 'hold.ack_status')?.detail).toContain(
      'accepted | rejected | error',
    );
  });

  it('accepts error as an ack, and requires a reason on it', async () => {
    const withReason = makeOrderSourceAdapter({
      tiny_src_release: () => ({ status: 'error', reason: 'shopify 503' }),
    });
    expect(
      failed(await runOrderSourceConformance(withReason.handlers, { slug: 'tiny-src', env: () => ({}) })),
    ).toEqual([]);

    const bare = makeOrderSourceAdapter({ tiny_src_release: () => ({ status: 'error' }) });
    expect(
      failed(await runOrderSourceConformance(bare.handlers, { slug: 'tiny-src', env: () => ({}) })),
    ).toEqual(['release.error_has_reason']);
  });

  it('refuses a capability claim the behaviour contradicts', async () => {
    const { handlers } = makeOrderSourceAdapter({
      tiny_src_describe: () => ({
        adapter_slug: 'tiny-src',
        channel: 'magento',
        capabilities: {
          supports_hold: false,
          supports_split: false,
          supports_cancel: true,
          supports_stock_write: false,
          request_model: 'orders',
        },
      }),
    });
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    expect(failed(report).sort()).toEqual(['set_stock_level.matches_capability', 'split.matches_capability']);
  });

  // update_address is `optionalSince: '1.4.0'`: an adapter written against
  // 1.3.0 has no handler for it and must stay conformant, and one that CLAIMS
  // the capability must actually implement it. Both directions, because the
  // hub decides whether to offer an operator an address form on the strength
  // of that flag alone.
  it('leaves a pre-1.4.0 adapter conformant: no update_address handler, no capability, no failure', async () => {
    const { handlers } = makeOrderSourceAdapter({});
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    expect(failed(report)).toEqual([]);
    expect(report.checks.some((c) => c.name.startsWith('update_address.'))).toBe(false);
  });

  it('fails an adapter that claims supports_address_update and answers "unsupported"', async () => {
    const { handlers } = makeOrderSourceAdapter({
      tiny_src_describe: () => ({
        adapter_slug: 'tiny-src',
        channel: 'shopify',
        capabilities: {
          supports_hold: true,
          supports_split: true,
          supports_cancel: true,
          supports_stock_write: true,
          supports_address_update: true,
          request_model: 'fulfilment_orders',
        },
      }),
      tiny_src_update_address: () => ({ status: 'rejected', reason: 'unsupported' }),
    });
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    expect(failed(report)).toEqual(['update_address.matches_capability']);
  });

  it('passes an adapter that claims supports_address_update and implements it', async () => {
    const { handlers } = makeOrderSourceAdapter({
      tiny_src_describe: () => ({
        adapter_slug: 'tiny-src',
        channel: 'shopify',
        capabilities: {
          supports_hold: true,
          supports_split: true,
          supports_cancel: true,
          supports_stock_write: true,
          supports_address_update: true,
          request_model: 'fulfilment_orders',
        },
      }),
      tiny_src_update_address: () => ({ status: 'accepted' }),
    });
    expect(
      failed(await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) })),
    ).toEqual([]);
  });

  it('fails a describe whose adapter_slug is not the install slug', async () => {
    const { handlers } = makeOrderSourceAdapter({
      tiny_src_describe: () => ({
        adapter_slug: 'something-else',
        channel: 'shopify',
        capabilities: {
          supports_hold: true,
          supports_split: true,
          supports_cancel: true,
          supports_stock_write: true,
          request_model: 'orders',
        },
      }),
    });
    const report = await runOrderSourceConformance(handlers, { slug: 'tiny-src', env: () => ({}) });
    expect(failed(report)).toEqual(['describe.adapter_slug_matches']);
  });
});
