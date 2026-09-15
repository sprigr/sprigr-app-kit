/**
 * Minimal conforming adapters, used to prove the harness passes a correct
 * adapter and to give each negative test one rule to break.
 *
 * They are deliberately NOT the mock examples: a harness verified only
 * against the app it ships with tests the pair, not the contract.
 */

export interface FakeVendor {
  calls: number;
}

const NOW = '2026-09-15T00:00:00Z';

export function makeProviderAdapter(overrides: Record<string, unknown> = {}) {
  const vendor: FakeVendor = { calls: 0 };
  const accepted = new Map<string, string>();
  let seq = 0;

  const handlers: Record<string, (args: never, env: never) => unknown> = {
    tiny_wh_describe: () => ({
      adapter_slug: 'tiny-wh',
      capabilities: {
        supports_cancel: true,
        supports_split: false,
        supports_hold: false,
        tracking_mode: 'push',
        stock_mode: 'snapshot',
        countries: ['AU'],
      },
    }),
    tiny_wh_list_warehouses: () => ({
      warehouses: [{ warehouse_key: 'wh_a', name: 'Warehouse A', country: 'AU', active: true }],
    }),
    tiny_wh_push_order: (args: never) => {
      const id = (args as unknown as { fulfilment_request_id: string }).fulfilment_request_id;
      const existing = accepted.get(id);
      if (existing) return { status: 'accepted', provider_ref: existing };
      vendor.calls += 1;
      seq += 1;
      const ref = `pr_${seq}`;
      accepted.set(id, ref);
      return { status: 'accepted', provider_ref: ref };
    },
    tiny_wh_cancel_order: () => ({ status: 'accepted' }),
    tiny_wh_get_order_status: () => ({ status: 'accepted', provider_status_raw: 'ACCEPTED' }),
    tiny_wh_get_stock: () => ({
      levels: [
        {
          provider_adapter: 'tiny-wh',
          warehouse_key: 'wh_a',
          sku: 'CONF-SKU-1',
          on_hand: 10,
          reserved: 1,
          held: 0,
          snapshot_at: NOW,
        },
      ],
    }),
    tiny_wh_health: () => ({ ok: true, credentials_ok: true, breaker_open: false }),
    ...(overrides as Record<string, (args: never, env: never) => unknown>),
  };

  return { handlers, vendor };
}

export function makeOrderSourceAdapter(overrides: Record<string, unknown> = {}) {
  const ack = () => ({ status: 'accepted' as const });
  const handlers: Record<string, (args: never, env: never) => unknown> = {
    tiny_src_describe: () => ({
      adapter_slug: 'tiny-src',
      channel: 'shopify',
      capabilities: {
        supports_hold: true,
        supports_split: true,
        supports_cancel: true,
        supports_stock_write: true,
        request_model: 'fulfilment_orders',
      },
    }),
    tiny_src_list_locations: () => ({
      locations: [{ source_location_ref: 'loc_1', name: 'Main', country: 'AU', active: true }],
    }),
    tiny_src_register_location: () => ({ status: 'accepted', source_location_ref: 'loc_1' }),
    tiny_src_get_order: () => ({
      found: true,
      order: {
        order_id: '',
        source_adapter: 'tiny-src',
        source_ref: 'src_conformance_order',
        source_number: 'PY1',
        channel: 'shopify',
        status: 'received',
        placed_at: NOW,
        currency: 'AUD',
        total_minor: 2500,
        customer_email: 'buyer@example.test',
        ship_to_json: '{"line1":"1 Test Street","city":"Brisbane","country":"AU"}',
        tags_json: '[]',
        hold_reason: '',
        updated_at: NOW,
      },
      lines: [
        {
          order_id: '',
          line_id: 'ln_1',
          source_line_ref: 'sl_conformance_1',
          sku: 'CONF-SKU-1',
          title: 'Conformance widget',
          quantity: 2,
          unit_price_minor: 1250,
          currency: 'AUD',
          requires_shipping: true,
        },
      ],
    }),
    tiny_src_accept_request: ack,
    tiny_src_reject_request: ack,
    tiny_src_mark_shipped: () => ({ status: 'accepted', source_fulfilment_ref: 'sf_1' }),
    tiny_src_hold: ack,
    tiny_src_release: ack,
    tiny_src_cancel: ack,
    tiny_src_split: () => ({ status: 'accepted', new_source_request_ref: 'srr_2' }),
    tiny_src_set_stock_level: ack,
    tiny_src_add_note: ack,
    ...(overrides as Record<string, (args: never, env: never) => unknown>),
  };
  return { handlers };
}

export function providerManifest(): Record<string, unknown> {
  return {
    metadata: { slug: 'tiny-wh' },
    tools: [
      { name: 'tiny_wh_describe', handler: 'src/handlers/provider.ts' },
      { name: 'tiny_wh_list_warehouses', handler: 'src/handlers/provider.ts' },
      { name: 'tiny_wh_push_order', handler: 'src/handlers/provider.ts', effects: 'write' },
      { name: 'tiny_wh_cancel_order', handler: 'src/handlers/provider.ts', effects: 'write' },
      { name: 'tiny_wh_get_order_status', handler: 'src/handlers/provider.ts' },
      { name: 'tiny_wh_get_stock', handler: 'src/handlers/provider.ts' },
      { name: 'tiny_wh_health', handler: 'src/handlers/provider.ts' },
    ],
    cross_tenant_tools: [
      'describe',
      'list_warehouses',
      'push_order',
      'cancel_order',
      'get_order_status',
      'get_stock',
      'health',
    ].map((op) => ({
      tool_name: `tiny_wh_${op}`,
      resource_type: 'fulfilment',
      action: op.startsWith('get') || op === 'describe' || op === 'health' || op === 'list_warehouses' ? 'read' : 'write',
      description: `op ${op}`,
      input_schema: { type: 'object', properties: {} },
      provides: { interface: 'fulfilment-hub/fulfilment_provider', op, version: '1.0.0' },
    })),
    events: {
      emits: [
        'provider.order.accepted',
        'provider.order.rejected',
        'provider.order.error',
        'provider.order.cancelled',
        'provider.order.cancel_refused',
        'provider.shipment.created',
      ].map((name) => ({ name, scope: 'per_install' })),
    },
  };
}
