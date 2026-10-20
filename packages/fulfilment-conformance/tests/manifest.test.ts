import { describe, expect, it } from 'vitest';
import { checkAdapterManifest } from '../src/manifest';
import { formatReport } from '../src/report';
import { providerManifest } from './fixtures';

function failed(report: { checks: { name: string; ok: boolean }[] }): string[] {
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe('checkAdapterManifest', () => {
  it('passes a conforming provider manifest', () => {
    const report = checkAdapterManifest(providerManifest(), 'fulfilment_provider');
    expect(failed(report), formatReport(report)).toEqual([]);
  });

  it('fails a tool name that does not carry the slug prefix', () => {
    const m = providerManifest();
    (m.cross_tenant_tools as { tool_name: string }[])[2]!.tool_name = 'push_order';
    (m.tools as { name: string }[])[2]!.name = 'push_order';
    // The two halves agree, so the tool IS declared; only the naming rule breaks.
    expect(failed(checkAdapterManifest(m, 'fulfilment_provider'))).toEqual(['provides.push_order.tool_name']);
  });

  it('fails a provides tag whose tool is missing from tools[]', () => {
    const m = providerManifest();
    m.tools = (m.tools as { name: string }[]).filter((t) => t.name !== 'tiny_wh_push_order');
    const report = checkAdapterManifest(m, 'fulfilment_provider');
    expect(failed(report)).toEqual(['provides.push_order.in_tools']);
  });

  it('fails a provides tag pinned at the wrong version', () => {
    const m = providerManifest();
    (m.cross_tenant_tools as { provides: { version: string } }[])[0]!.provides.version = '1.1.0';
    expect(failed(checkAdapterManifest(m, 'fulfilment_provider'))).toEqual(['provides.describe.version']);
  });

  // An op added after 1.0.0 cannot honestly be pinned 1.0.0, so it may carry
  // the version that introduced it (or a later 1.x). Never an earlier one,
  // and the 1.0.0 ops keep their exact pin (the test above).
  function withUpdateShipTo(version: string): Record<string, unknown> {
    const m = providerManifest();
    (m.tools as Record<string, unknown>[]).push({
      name: 'tiny_wh_update_ship_to',
      handler: 'src/handlers/provider.ts',
      effects: 'write',
    });
    (m.cross_tenant_tools as Record<string, unknown>[]).push({
      tool_name: 'tiny_wh_update_ship_to',
      resource_type: 'fulfilment',
      action: 'write',
      description: 'op update_ship_to',
      input_schema: { type: 'object', properties: {} },
      provides: { interface: 'fulfilment-hub/fulfilment_provider', op: 'update_ship_to', version },
    });
    (m.events as { emits: Record<string, unknown>[] }).emits.push(
      { name: 'provider.order.address_updated', scope: 'per_install' },
      { name: 'provider.order.address_update_refused', scope: 'per_install' },
    );
    return m;
  }

  it('accepts update_ship_to pinned at 1.4.0 (when it was added), a later 1.x, or 1.0.0', () => {
    for (const v of ['1.4.0', '1.5.2', '1.0.0']) {
      expect(failed(checkAdapterManifest(withUpdateShipTo(v), 'fulfilment_provider')), v).toEqual([]);
    }
  });

  it('fails update_ship_to pinned before it existed, or outside 1.x', () => {
    for (const v of ['1.3.0', '2.0.0', '1.4', 'latest']) {
      expect(failed(checkAdapterManifest(withUpdateShipTo(v), 'fulfilment_provider')), v).toEqual([
        'provides.update_ship_to.version',
      ]);
    }
  });

  // create_inbound (1.5.0) follows the same rules as update_ship_to: pinned at
  // 1.5.0 or later, and claiming it requires the two answer events (but not
  // `received`, which arrives later and answers nothing).
  function withCreateInbound(version: string, emits: string[]): Record<string, unknown> {
    const m = providerManifest();
    (m.tools as Record<string, unknown>[]).push({
      name: 'tiny_wh_create_inbound',
      handler: 'src/handlers/provider.ts',
      effects: 'write',
    });
    (m.cross_tenant_tools as Record<string, unknown>[]).push({
      tool_name: 'tiny_wh_create_inbound',
      resource_type: 'fulfilment',
      action: 'write',
      description: 'op create_inbound',
      input_schema: { type: 'object', properties: {} },
      provides: { interface: 'fulfilment-hub/fulfilment_provider', op: 'create_inbound', version },
    });
    (m.events as { emits: Record<string, unknown>[] }).emits.push(
      ...emits.map((name) => ({ name, scope: 'per_install' })),
    );
    return m;
  }
  const INBOUND_EMITS = ['provider.inbound.accepted', 'provider.inbound.refused', 'provider.inbound.received'];

  it('accepts create_inbound pinned at 1.5.0 or later with its events declared', () => {
    for (const v of ['1.5.0', '1.6.1', '1.0.0']) {
      const report = checkAdapterManifest(withCreateInbound(v, INBOUND_EMITS), 'fulfilment_provider');
      expect(failed(report), `${v}\n${formatReport(report)}`).toEqual([]);
    }
    // `received` is not required by the op.
    const m = withCreateInbound('1.5.0', ['provider.inbound.accepted', 'provider.inbound.refused']);
    expect(failed(checkAdapterManifest(m, 'fulfilment_provider'))).toEqual([]);
  });

  it('fails create_inbound pinned before it existed', () => {
    for (const v of ['1.4.0', '2.0.0']) {
      expect(failed(checkAdapterManifest(withCreateInbound(v, INBOUND_EMITS), 'fulfilment_provider')), v).toEqual([
        'provides.create_inbound.version',
      ]);
    }
  });

  it('fails create_inbound claimed without its answer events', () => {
    const m = withCreateInbound('1.5.0', ['provider.inbound.accepted']);
    expect(failed(checkAdapterManifest(m, 'fulfilment_provider'))).toEqual(['events.required_emits_declared']);
  });

  it('fails a write op with no effects: write', () => {
    const m = providerManifest();
    delete (m.tools as Record<string, unknown>[])[2]!.effects;
    expect(failed(checkAdapterManifest(m, 'fulfilment_provider'))).toEqual(['provides.push_order.effects_write']);
  });

  it('fails an unclaimed op, and passes when the caller allows it', () => {
    const m = providerManifest();
    (m.cross_tenant_tools as unknown[]).pop(); // drop `health`
    expect(failed(checkAdapterManifest(m, 'fulfilment_provider'))).toEqual(['provides.covers_every_op']);
    expect(failed(checkAdapterManifest(m, 'fulfilment_provider', { allowUnclaimedOps: ['health'] }))).toEqual([]);
  });

  it('fails an op name that is not in the contract', () => {
    const m = providerManifest();
    (m.cross_tenant_tools as { provides: { op: string } }[])[0]!.provides.op = 'describe_v2';
    const report = checkAdapterManifest(m, 'fulfilment_provider');
    expect(failed(report)).toContain('provides.describe_v2.is_a_contract_op');
    expect(failed(report)).toContain('provides.covers_every_op');
  });

  it('fails a mistyped event name and a missing required emit', () => {
    const m = providerManifest();
    m.events = { emits: [{ name: 'provider.order.acepted' }, { name: 'provider.order.error' }] };
    const report = checkAdapterManifest(m, 'fulfilment_provider');
    expect(failed(report)).toContain('events.names_are_contract_events');
    const emits = report.checks.find((c) => c.name === 'events.required_emits_declared');
    expect(emits?.ok).toBe(false);
    expect(emits?.detail).toContain('provider.order.accepted');
    expect(emits?.detail).toContain('provider.order.cancelled');
  });

  it('does not demand cancel events from an adapter that never claims cancel_order', () => {
    const m = providerManifest();
    m.cross_tenant_tools = (m.cross_tenant_tools as { provides: { op: string } }[]).filter(
      (t) => t.provides.op !== 'cancel_order',
    );
    m.events = {
      emits: ['provider.order.accepted', 'provider.order.rejected', 'provider.order.error'].map((name) => ({ name })),
    };
    expect(failed(checkAdapterManifest(m, 'fulfilment_provider', { allowUnclaimedOps: ['cancel_order'] }))).toEqual([]);
  });

  it('fails a provider manifest checked as an order source', () => {
    const report = checkAdapterManifest(providerManifest(), 'order_source');
    expect(failed(report)).toContain('provides.any');
    expect(failed(report)).toContain('provides.covers_every_op');
    expect(failed(report)).toContain('events.required_emits_declared');
  });

  it('refuses the order_source.* event spelling the platform rejects at publish', () => {
    const m = {
      metadata: { slug: 'tiny-src' },
      tools: [{ name: 'tiny_src_describe', handler: 'h.ts' }],
      cross_tenant_tools: [
        {
          tool_name: 'tiny_src_describe',
          resource_type: 'orders',
          action: 'read',
          description: 'd',
          input_schema: {},
          provides: { interface: 'fulfilment-hub/order_source', op: 'describe', version: '1.0.0' },
        },
      ],
      events: {
        emits: [{ name: 'order_source.order.created' }, { name: 'order_source.request.submitted' }],
      },
    };
    const report = checkAdapterManifest(m, 'order_source', {
      allowUnclaimedOps: [
        'list_locations', 'register_location', 'get_order', 'accept_request', 'reject_request',
        'mark_shipped', 'hold', 'release', 'cancel', 'split', 'set_stock_level', 'add_note',
      ],
    });
    // order_source.* is outside the role's `source.` prefix, so the typo guard
    // cannot see it; the required-emits check is what catches the spelling.
    const emits = report.checks.find((c) => c.name === 'events.required_emits_declared');
    expect(emits?.ok).toBe(false);
    expect(emits?.detail).toContain('source.order.created');
    expect(emits?.detail).toContain('source.request.submitted');

    m.events.emits = [{ name: 'source.order.created' }, { name: 'source.request.submitted' }];
    expect(
      checkAdapterManifest(m, 'order_source', {
        allowUnclaimedOps: [
          'list_locations', 'register_location', 'get_order', 'accept_request', 'reject_request',
          'mark_shipped', 'hold', 'release', 'cancel', 'split', 'set_stock_level', 'add_note',
        ],
      }).ok,
    ).toBe(true);
  });

  it('fails a manifest that is not an object', () => {
    expect(failed(checkAdapterManifest(null, 'order_source'))).toEqual(['manifest.parsed']);
  });
});
