/**
 * Scaffold templates for the two fulfilment-hub v1 adapter roles.
 *
 * `pnpm create:app <slug> --template fulfilment-provider` and
 * `--template order-source` generate a complete adapter: a manifest that
 * claims every op of the interface with a `provides` tag, a handler map that
 * already keeps the contract (async acks, idempotent `push_order`, integer
 * money, ISO 8601 UTC stamps), the events the hub subscribes to, and a
 * conformance test that runs the whole suite. The generated app is GREEN on
 * the first `pnpm test`, so the first thing it proves is the wiring, and it
 * goes red the moment a rule is broken while the vendor code is filled in.
 *
 * The op tables below are transcribed from
 * `docs/interfaces/fulfilment-hub-v1.md`, the same source
 * `packages/fulfilment-conformance/src/contract.ts` reads. Drift between the
 * two is caught by `packages/fulfilment-conformance/tests/scaffold.test.ts`,
 * which scaffolds both templates and runs `checkAdapterManifest` over the
 * result.
 *
 * Node stdlib only, like the rest of tools/.
 */

export const ADAPTER_TEMPLATES = ['fulfilment-provider', 'order-source'];

const INTERFACE_VERSION = '1.0.0';

const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const int = (description) => ({ type: 'number', description: description ?? 'Integer.' });

/**
 * The two interfaces do NOT share one ack enum (contract section 7,
 * clarification 2). A provider says `queued` when it has taken the request
 * but not yet sent it, and reports transient trouble later through
 * `provider.order.error { retryable: true }`. An order source has no such
 * event, so it says `error` inline for a transient failure the hub may retry.
 */
const ackWith = (statuses, needsReason) => (extra = {}) => ({
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: statuses,
      description: 'Async ack. The outcome arrives as an event, never in this response.',
    },
    ...extra,
    reason: str(`Required when status is ${needsReason}.`),
  },
  required: ['status'],
});

const providerAck = ackWith(['accepted', 'queued', 'rejected'], 'rejected');
const sourceAck = ackWith(['accepted', 'rejected', 'error'], 'rejected or error');

const ADDRESS = {
  type: 'object',
  properties: {
    name: str(), company: str(), line1: str(), line2: str(), city: str(), region: str(),
    postcode: str(), country: str('ISO 3166-1 alpha-2.'), phone: str(), email: str(),
  },
  required: ['line1', 'country'],
};

const ORDER_SHAPE = {
  type: 'object',
  properties: {
    order_id: str('Empty: the hub assigns it.'), source_adapter: str(), source_ref: str(),
    source_number: str(), channel: str(), status: str(), placed_at: str('ISO 8601 UTC.'),
    currency: str('ISO 4217.'), total_minor: int('Integer minor units.'), customer_email: str(),
    ship_to_json: str(), tags_json: str(), hold_reason: str(), updated_at: str('ISO 8601 UTC.'),
  },
  required: ['order_id', 'source_adapter', 'source_ref', 'source_number', 'channel', 'status',
    'placed_at', 'currency', 'total_minor', 'customer_email', 'ship_to_json', 'tags_json',
    'hold_reason', 'updated_at'],
};

const LINE_SHAPE = {
  type: 'object',
  properties: {
    order_id: str(), line_id: str(), source_line_ref: str(), sku: str(), title: str(),
    quantity: int(), unit_price_minor: int('Integer minor units.'), currency: str(),
    requires_shipping: { type: 'boolean' },
  },
  required: ['order_id', 'line_id', 'source_line_ref', 'sku', 'title', 'quantity',
    'unit_price_minor', 'currency', 'requires_shipping'],
};

const REQUEST_LINES = {
  type: 'array',
  items: {
    type: 'object',
    properties: { source_line_ref: str(), quantity: int() },
    required: ['source_line_ref', 'quantity'],
  },
};

// ---------------------------------------------------------------------------
// fulfilment-hub/fulfilment_provider
// ---------------------------------------------------------------------------

const PROVIDER_OPS = {
  describe: {
    effects: 'read',
    description: 'Report this adapter slug and its capability block. The hub reads capabilities to choose a path and never infers a limit from error text.',
    input: { type: 'object', properties: {} },
    output: {
      type: 'object',
      properties: {
        adapter_slug: str(),
        capabilities: {
          type: 'object',
          properties: {
            supports_cancel: { type: 'boolean' }, supports_split: { type: 'boolean' },
            supports_hold: { type: 'boolean' },
            tracking_mode: { type: 'string', enum: ['push', 'poll', 'scrape'] },
            stock_mode: { type: 'string', enum: ['snapshot', 'delta', 'none'] },
            countries: { type: 'array', items: { type: 'string' } },
          },
          required: ['supports_cancel', 'supports_split', 'supports_hold', 'tracking_mode', 'stock_mode', 'countries'],
        },
      },
      required: ['adapter_slug', 'capabilities'],
    },
  },
  list_warehouses: {
    effects: 'read',
    description: 'List the warehouses the hub may route to. warehouse_key is the opaque id push_order takes.',
    input: { type: 'object', properties: {} },
    output: {
      type: 'object',
      properties: {
        warehouses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              warehouse_key: str(), name: str(), country: str('ISO 3166-1 alpha-2.'),
              cutoff_local_time: str(), active: { type: 'boolean' },
            },
            required: ['warehouse_key', 'name', 'country', 'active'],
          },
        },
      },
      required: ['warehouses'],
    },
  },
  push_order: {
    effects: 'write',
    description: 'Send one fulfilment request to a warehouse. Idempotent on fulfilment_request_id: a repeat call returns the same provider_ref and does not reach the warehouse again. Acknowledges inside the dispatch budget; the outcome arrives as provider.order.accepted, .rejected or .error.',
    input: {
      type: 'object',
      properties: {
        fulfilment_request_id: str('The hub id. The idempotency key.'),
        order_id: str(), source_number: str(), warehouse_key: str(), ship_to: ADDRESS,
        customer_email: str(),
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              line_id: str(), sku: str(), title: str(), quantity: int(),
              unit_price_minor: int('Integer minor units.'), currency: str(),
            },
            required: ['line_id', 'sku', 'quantity'],
          },
        },
        currency: str('ISO 4217.'), total_minor: int('Integer minor units.'),
        notes: str(), callback_hint: str(),
      },
      required: ['fulfilment_request_id', 'order_id', 'warehouse_key', 'lines'],
    },
    output: providerAck({ provider_ref: str("The warehouse's own id. Stable for a given fulfilment_request_id.") }),
  },
  cancel_order: {
    effects: 'write',
    description: 'Ask the warehouse to cancel a request. The outcome arrives as provider.order.cancelled or provider.order.cancel_refused.',
    input: {
      type: 'object',
      properties: { fulfilment_request_id: str(), provider_ref: str(), reason: str() },
      required: ['fulfilment_request_id', 'provider_ref', 'reason'],
    },
    output: providerAck(),
  },
  get_order_status: {
    effects: 'read',
    description: 'Current provider-side status of one request, with tracking once it has shipped.',
    input: {
      type: 'object',
      properties: { fulfilment_request_id: str(), provider_ref: str() },
      required: ['fulfilment_request_id', 'provider_ref'],
    },
    output: {
      type: 'object',
      properties: {
        status: str(), provider_status_raw: str(),
        tracking: {
          type: 'object',
          properties: { carrier: str(), tracking_number: str(), tracking_url: str() },
          required: ['carrier', 'tracking_number', 'tracking_url'],
        },
      },
      required: ['status'],
    },
  },
  get_stock: {
    effects: 'read',
    description: 'Stock levels from the warehouse. Integer quantities, ISO 8601 UTC snapshot_at.',
    input: {
      type: 'object',
      properties: { warehouse_key: str(), skus: { type: 'array', items: { type: 'string' } } },
    },
    output: {
      type: 'object',
      properties: {
        levels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              provider_adapter: str(), warehouse_key: str(), sku: str(),
              on_hand: int(), reserved: int(), held: int(), snapshot_at: str('ISO 8601 UTC.'),
            },
            required: ['provider_adapter', 'warehouse_key', 'sku', 'on_hand', 'reserved', 'held', 'snapshot_at'],
          },
        },
      },
      required: ['levels'],
    },
  },
  health: {
    effects: 'read',
    description: 'Credential and breaker state for this install, so the hub can stop routing to a warehouse that is down.',
    input: { type: 'object', properties: {} },
    output: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' }, credentials_ok: { type: 'boolean' },
        last_callback_at: str('ISO 8601 UTC.'), breaker_open: { type: 'boolean' }, detail: str(),
      },
      required: ['ok', 'credentials_ok', 'breaker_open'],
    },
  },
};

const PROVIDER_EMITS = [
  ['provider.order.accepted', 'The warehouse accepted a pushed request.', ['adapter_slug', 'fulfilment_request_id', 'provider_ref', 'warehouse_key']],
  ['provider.order.rejected', 'The warehouse refused the request outright. Not retryable.', ['adapter_slug', 'fulfilment_request_id', 'reason']],
  ['provider.order.error', 'A transient failure pushing the request. Carries retryable.', ['adapter_slug', 'fulfilment_request_id', 'reason', 'retryable']],
  ['provider.order.cancelled', 'A cancellation completed at the warehouse.', ['adapter_slug', 'fulfilment_request_id', 'provider_ref']],
  ['provider.order.cancel_refused', 'The warehouse refused to cancel (already picked or shipped).', ['adapter_slug', 'fulfilment_request_id', 'provider_ref', 'reason']],
  ['provider.shipment.created', 'A shipment left the warehouse, with carrier and tracking.', ['adapter_slug', 'fulfilment_request_id', 'provider_ref', 'shipment']],
  ['provider.shipment.event', 'A carrier scan, mapped onto the contract stage enum.', ['adapter_slug', 'provider_shipment_ref', 'tracking_number', 'stage', 'occurred_at', 'provider_event_ref']],
  ['provider.stock.snapshot', 'A stock snapshot for one warehouse.', ['adapter_slug', 'warehouse_key', 'snapshot_at', 'full', 'levels']],
];

// ---------------------------------------------------------------------------
// fulfilment-hub/order_source
// ---------------------------------------------------------------------------

const ORDER_SOURCE_OPS = {
  describe: {
    effects: 'read',
    description: 'Report this adapter slug, its channel and its capability block. The hub reads capabilities to choose a path and never infers a limit from error text.',
    input: { type: 'object', properties: {} },
    output: {
      type: 'object',
      properties: {
        adapter_slug: str(), channel: str(),
        capabilities: {
          type: 'object',
          properties: {
            supports_hold: { type: 'boolean' }, supports_split: { type: 'boolean' },
            supports_cancel: { type: 'boolean' }, supports_stock_write: { type: 'boolean' },
            request_model: { type: 'string', enum: ['fulfilment_orders', 'orders'] },
          },
          required: ['supports_hold', 'supports_split', 'supports_cancel', 'supports_stock_write', 'request_model'],
        },
      },
      required: ['adapter_slug', 'channel', 'capabilities'],
    },
  },
  list_locations: {
    effects: 'read',
    description: 'List the selling system locations a provider warehouse can be mapped onto.',
    input: { type: 'object', properties: {} },
    output: {
      type: 'object',
      properties: {
        locations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { source_location_ref: str(), name: str(), country: str('ISO 3166-1 alpha-2.'), active: { type: 'boolean' } },
            required: ['source_location_ref', 'name', 'country', 'active'],
          },
        },
      },
      required: ['locations'],
    },
  },
  register_location: {
    effects: 'write',
    description: 'Create a selling system location for one provider warehouse, so stock and fulfilments can be attributed to it.',
    input: {
      type: 'object',
      properties: { warehouse_key: str(), name: str(), country: str('ISO 3166-1 alpha-2.'), address: ADDRESS },
      required: ['warehouse_key', 'name', 'country'],
    },
    output: sourceAck({ source_location_ref: str() }),
  },
  get_order: {
    effects: 'read',
    description: 'Read one order and its lines in the canonical shapes, by the selling system id. order_id comes back empty: the hub assigns it.',
    input: { type: 'object', properties: { source_ref: str() }, required: ['source_ref'] },
    output: {
      type: 'object',
      properties: { found: { type: 'boolean' }, order: ORDER_SHAPE, lines: { type: 'array', items: LINE_SHAPE } },
      required: ['found'],
    },
  },
  accept_request: {
    effects: 'write',
    description: 'Tell the selling system a fulfilment request was accepted by a warehouse.',
    input: { type: 'object', properties: { source_request_ref: str() }, required: ['source_request_ref'] },
    output: sourceAck(),
  },
  reject_request: {
    effects: 'write',
    description: 'Tell the selling system a fulfilment request was refused, with the reason to show the merchant.',
    input: { type: 'object', properties: { source_request_ref: str(), reason: str() }, required: ['source_request_ref', 'reason'] },
    output: sourceAck(),
  },
  mark_shipped: {
    effects: 'write',
    description: 'Write a shipment back to the selling system: carrier, tracking and the lines it covers.',
    input: {
      type: 'object',
      properties: {
        source_request_ref: str(), source_ref: str(), carrier: str(), tracking_number: str(),
        tracking_url: str(), lines: REQUEST_LINES, notify_customer: { type: 'boolean' },
      },
      required: ['source_request_ref', 'source_ref', 'carrier', 'tracking_number', 'lines', 'notify_customer'],
    },
    output: sourceAck({ source_fulfilment_ref: str() }),
  },
  hold: {
    effects: 'write',
    description: 'Put a fulfilment request on hold in the selling system (backorder, fraud check, presale).',
    input: { type: 'object', properties: { source_request_ref: str(), reason: str() }, required: ['source_request_ref', 'reason'] },
    output: sourceAck(),
  },
  release: {
    effects: 'write',
    description: 'Release a held request. Emits source.request.hold_released, which re-triggers routing.',
    input: { type: 'object', properties: { source_request_ref: str() }, required: ['source_request_ref'] },
    output: sourceAck(),
  },
  cancel: {
    effects: 'write',
    description: 'Cancel a fulfilment request in the selling system.',
    input: { type: 'object', properties: { source_request_ref: str(), reason: str() }, required: ['source_request_ref', 'reason'] },
    output: sourceAck(),
  },
  split: {
    effects: 'write',
    description: 'Split lines off a fulfilment request into a new one, for a mixed order the hub routes to two warehouses.',
    input: { type: 'object', properties: { source_request_ref: str(), lines: REQUEST_LINES }, required: ['source_request_ref', 'lines'] },
    output: sourceAck({ new_source_request_ref: str() }),
  },
  set_stock_level: {
    effects: 'write',
    description: 'Push a reconciled sellable quantity back to the selling system for one SKU at one location. Integer only.',
    input: {
      type: 'object',
      properties: { source_location_ref: str(), sku: str(), on_hand: int() },
      required: ['source_location_ref', 'sku', 'on_hand'],
    },
    output: sourceAck(),
  },
  add_note: {
    effects: 'write',
    description: 'Append a note (and optional tags) to an order, for an exception the hub wants visible to the merchant. Appends, never replaces.',
    input: {
      type: 'object',
      properties: { source_ref: str(), note: str(), tags: { type: 'array', items: { type: 'string' } } },
      required: ['source_ref', 'note'],
    },
    output: sourceAck(),
  },
};

const ORDER_SOURCE_EMITS = [
  ['source.order.created', 'A new order exists in the selling system, with its canonical order and lines.', ['adapter_slug', 'order', 'lines']],
  ['source.order.updated', 'An existing order changed. `changed` names the fields.', ['adapter_slug', 'order', 'lines', 'changed']],
  ['source.order.cancelled', 'The whole order was cancelled in the selling system.', ['adapter_slug', 'source_ref', 'reason']],
  ['source.request.submitted', 'THE routing trigger: a fulfilment request is ready to be routed to a warehouse.', ['adapter_slug', 'source_ref', 'source_request_ref', 'source_location_ref', 'lines']],
  ['source.request.cancellation_submitted', 'The merchant asked to cancel a request the hub may already have pushed.', ['adapter_slug', 'source_ref', 'source_request_ref', 'reason']],
  ['source.request.hold_released', 'A held request is routable again.', ['adapter_slug', 'source_ref', 'source_request_ref']],
  ['source.stock.changed', 'A sellable quantity changed in the selling system.', ['adapter_slug', 'source_location_ref', 'sku', 'on_hand']],
];

const ROLES = {
  'fulfilment-provider': {
    role: 'fulfilment_provider',
    interfaceId: 'fulfilment-hub/fulfilment_provider',
    ops: PROVIDER_OPS,
    emits: PROVIDER_EMITS,
    resourceType: 'fulfilment',
    handlerFile: (slug) => `src/handlers/${slug}-provider.ts`,
    noun: 'warehouse or 3PL',
  },
  'order-source': {
    role: 'order_source',
    interfaceId: 'fulfilment-hub/order_source',
    ops: ORDER_SOURCE_OPS,
    emits: ORDER_SOURCE_EMITS,
    resourceType: 'orders',
    handlerFile: (slug) => `src/handlers/${slug}-order-source.ts`,
    noun: 'selling system',
  },
};

function emitSchema(required) {
  const known = {
    retryable: { type: 'boolean' },
    full: { type: 'boolean' },
    on_hand: { type: 'number' },
    shipment: { type: 'object' },
    order: { type: 'object' },
    lines: { type: 'array', items: { type: 'object' } },
    levels: { type: 'array', items: { type: 'object' } },
    changed: { type: 'array', items: { type: 'string' } },
  };
  return {
    type: 'object',
    properties: Object.fromEntries(required.map((f) => [f, known[f] ?? { type: 'string' }])),
    required,
  };
}

export function adapterManifest({ slug, slugU, name, template }) {
  const cfg = ROLES[template];
  const handler = cfg.handlerFile(slug);
  return {
    sprigr_app: { version: '1' },
    metadata: {
      name,
      slug,
      version: '0.0.1',
      description: `TODO: one sentence saying which ${cfg.noun} this adapter connects to the fulfilment hub.`,
      author: { name: 'Sprigr Company', email: 'platform@sprigr.com' },
      category: 'operations',
      tags: ['fulfilment', 'interfaces'],
    },
    kind: 'tool',
    runtime: { entry: 'src/app/page.tsx', tier: 'ssr', framework: 'next' },
    permissions: {
      scopes: ['tools:register'],
      // The adapter talks to its own vendor and to the hub, nothing else.
      network_domains: ['TODO-api.example.com'],
    },
    migrations: [
      { file: 'migrations/0001_init.sql', version: 1, description: 'Settings, and the store every op reads and writes.' },
    ],
    tools: Object.entries(cfg.ops).map(([op, spec]) => ({
      name: `${slugU}_${op}`,
      description: spec.description,
      handler,
      ...(spec.effects === 'write' ? { effects: 'write' } : {}),
      input_schema: spec.input,
      output_schema: spec.output,
    })),
    cross_tenant_tools: Object.entries(cfg.ops).map(([op, spec]) => ({
      tool_name: `${slugU}_${op}`,
      resource_type: cfg.resourceType,
      action: spec.effects,
      description: spec.description,
      input_schema: spec.input,
      output_schema: spec.output,
      provides: { interface: cfg.interfaceId, op, version: INTERFACE_VERSION },
    })),
    events: {
      emits: cfg.emits.map(([eventName, description, required]) => ({
        name: eventName,
        description,
        scope: 'per_install',
        schema: emitSchema(required),
      })),
    },
  };
}

export function adapterFiles({ slug, slugU, name, pascal, template }) {
  return template === 'fulfilment-provider'
    ? providerFiles({ slug, slugU, name, pascal })
    : orderSourceFiles({ slug, slugU, name, pascal });
}

// ---------------------------------------------------------------------------
// Shared source fragments
// ---------------------------------------------------------------------------

function envTs({ slugU, name, pascal, eventNoun }) {
  return `/**
 * ${name} - per-install env contract and the host-call guard.
 *
 * The platform surface an adapter uses is \`env.SPRIGR.emit\` (the ${eventNoun}
 * events the hub subscribes to) and \`env.SPRIGR.log\` (telemetry that must
 * never become D1 rows). Both are staging-only: under \`sprigr app dev\` the
 * harness's SPRIGR stub throws, and in a unit test there is no SPRIGR at all.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export interface ${pascal}Host {
  emit(event: string, payload: Record<string, unknown>): Promise<unknown>;
  log?(entry: { level: string; message: string; context?: Record<string, unknown> }): Promise<unknown>;
}

export interface ${pascal}Env {
  /** Per-install D1. Always bound on the platform; absent in a unit test. */
  DB?: D1Like;
  SPRIGR?: ${pascal}Host;
  INSTALL_ID?: string;
  COMPANY_ID?: string;
  APP_SLUG?: string;
  [key: string]: unknown;
}

declare global {
  interface CloudflareEnv extends ${pascal}Env {}
}

export {};

export interface EmitOutcome {
  event: string;
  emitted: boolean;
  reason?: string;
}

/**
 * Emit, reporting rather than throwing when the host is not there. Every op
 * must acknowledge inside the dispatch budget whatever the platform is
 * doing, so a failed emit is a recorded outcome, never an exception that
 * turns an ack into a 500.
 */
export async function safeEmit(
  env: ${pascal}Env,
  event: string,
  payload: Record<string, unknown>,
): Promise<EmitOutcome> {
  if (!env.SPRIGR) return { event, emitted: false, reason: 'no SPRIGR host bound (local unit test)' };
  try {
    await env.SPRIGR.emit(event, payload);
    return { event, emitted: true };
  } catch (err) {
    return { event, emitted: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Fire-and-forget telemetry. Never a D1 row: these fire per request. */
export async function report(
  env: ${pascal}Env,
  message: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await env.SPRIGR?.log?.({ level: 'info', message, context });
  } catch {
    console.warn('[${slugU}] ' + message, context);
  }
}
`;
}

function conformanceTestTs({ slug, role, handlerImport, fixtures }) {
  return `/**
 * The whole ${role === 'order_source' ? 'fulfilment-hub/order_source' : 'fulfilment-hub/fulfilment_provider'} contract, run against this app's real
 * handler map and its manifest.
 *
 * This file should stay green as the vendor code is filled in. When it goes
 * red, read the check name: it names the contract rule that broke, and the
 * detail says what the hub would have done about it.
 */
import { describeConformance } from '@sprigr/apps-fulfilment-conformance/vitest';
import handlers from '${handlerImport}';
import manifest from '../sprigr-app.json';
import { fakeEnv } from './__helpers__/fake-env';

const env = fakeEnv();

describeConformance({
  role: '${role}',
  slug: '${slug}',
  handlers,
  manifest,
  env: () => env,
${fixtures}});
`;
}

function pageTsx({ name, interfaceId, blurb }) {
  return `export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main>
      <h1 style={{ marginTop: 0 }}>${name}</h1>
      <p style={{ color: '#555' }}>
        An implementer of <code>${interfaceId}</code> v1.0.0. ${blurb}
      </p>
      <p style={{ color: '#555' }}>TODO: replace with the real per-install settings UI.</p>
    </main>
  );
}
`;
}

function layoutTsx({ name }) {
  return `export const metadata = {
  title: '${name} - Sprigr',
  description: '${name} fulfilment-hub adapter for Sprigr',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '2rem', maxWidth: 760 }}>
        {children}
      </body>
    </html>
  );
}
`;
}

function fakeEnvTs({ pascal, name }) {
  return `/**
 * A fake env for the ${name} handler map.
 *
 * No \`DB\`, so \`depsFor\` hands the handlers their in-memory store; \`recorded\`
 * captures every event the app would have emitted. Nothing here stands in for
 * a handler: the tests drive the exact map the runtime dispatches.
 */

import { depsFor } from '../../src/lib/deps';
import type { ${pascal}Env } from '../../src/lib/env';

export interface FakeEnv extends ${pascal}Env {
  recorded: Array<{ event: string; payload: Record<string, unknown> }>;
}

export function fakeEnv(): FakeEnv {
  const recorded: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    recorded,
    SPRIGR: {
      async emit(event, payload) {
        recorded.push({ event, payload });
        return { ok: true };
      },
      async log() {
        return { ok: true };
      },
    },
  };
}

/** The deps bundle the handlers will resolve for a DB-less env. */
export function envDeps(env: ${pascal}Env) {
  return depsFor(env);
}
`;
}

// ---------------------------------------------------------------------------
// fulfilment-provider files
// ---------------------------------------------------------------------------

function providerFiles({ slug, slugU, name, pascal }) {
  const files = {};

  files['migrations/0001_init.sql'] = `-- Per-install D1 schema for the ${name} fulfilment-hub adapter.
--
-- IMMUTABLE once shipped. Schema changes go in new numbered files.
--
-- The one table that matters is the push_order idempotency record. The hub's
-- outbox is at-least-once, so without a record keyed on fulfilment_request_id
-- a redelivery ships the order twice. The row is written on a MISS: a repeat
-- push reads it and returns the stored provider_ref without writing again.
--
-- Do NOT add a per-event audit table here. D1 charges per row written; use
-- env.SPRIGR.log() for telemetry and keep D1 for state.

CREATE TABLE ${slugU}_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ${slugU}_requests (
  fulfilment_request_id  TEXT PRIMARY KEY,
  provider_ref           TEXT NOT NULL,
  order_id               TEXT NOT NULL,
  warehouse_key          TEXT NOT NULL,
  lines_json             TEXT NOT NULL,
  stage                  TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
`;

  files['src/lib/env.ts'] = envTs({ slugU, name, pascal, eventNoun: 'provider.*' });

  files['src/lib/store.ts'] = `/**
 * ${name} - the request store.
 *
 * Two implementations of one interface: the per-install D1 table the platform
 * binds, and an in-memory map. The in-memory one is what lets the conformance
 * harness drive the REAL handler map with no D1 behind it.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export type RequestStage = 'pushed' | 'accepted' | 'rejected' | 'shipped' | 'cancelled';

export interface RequestRecord {
  fulfilment_request_id: string;
  provider_ref: string;
  order_id: string;
  warehouse_key: string;
  lines_json: string;
  stage: RequestStage;
  created_at: string;
  updated_at: string;
}

export interface RequestStore {
  get(fulfilmentRequestId: string): Promise<RequestRecord | null>;
  /** Insert only. The caller reads first, so this never fires on a repeat push. */
  insert(record: RequestRecord): Promise<void>;
  setStage(fulfilmentRequestId: string, stage: RequestStage, updatedAt: string): Promise<void>;
}

export function d1Store(db: D1Like): RequestStore {
  return {
    async get(id) {
      return db
        .prepare(
          \`SELECT fulfilment_request_id, provider_ref, order_id, warehouse_key,
                  lines_json, stage, created_at, updated_at
             FROM ${slugU}_requests WHERE fulfilment_request_id = ?\`,
        )
        .bind(id)
        .first<RequestRecord>();
    },
    async insert(record) {
      await db
        .prepare(
          \`INSERT INTO ${slugU}_requests
             (fulfilment_request_id, provider_ref, order_id, warehouse_key,
              lines_json, stage, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(fulfilment_request_id) DO NOTHING\`,
        )
        .bind(
          record.fulfilment_request_id,
          record.provider_ref,
          record.order_id,
          record.warehouse_key,
          record.lines_json,
          record.stage,
          record.created_at,
          record.updated_at,
        )
        .run();
    },
    async setStage(id, stage, updatedAt) {
      await db
        .prepare(\`UPDATE ${slugU}_requests SET stage = ?, updated_at = ? WHERE fulfilment_request_id = ?\`)
        .bind(stage, updatedAt, id)
        .run();
    },
  };
}

export function memoryStore(): RequestStore {
  const rows = new Map<string, RequestRecord>();
  return {
    async get(id) {
      return rows.get(id) ?? null;
    },
    async insert(record) {
      if (!rows.has(record.fulfilment_request_id)) rows.set(record.fulfilment_request_id, { ...record });
    },
    async setStage(id, stage, updatedAt) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, stage, updated_at: updatedAt });
    },
  };
}
`;

  files['src/lib/vendor.ts'] = `/**
 * ${name} - the warehouse API client.
 *
 * TODO: replace the body of \`createOrder\` with the real call. Keep the
 * \`calls\` counter: the conformance harness reads it to prove a repeat
 * \`push_order\` was served from the idempotency record rather than sent to
 * the warehouse a second time.
 *
 * Whatever you put here must stay inside the dispatch budget. If the vendor
 * is slow, enqueue the work and return \`queued\` rather than waiting: the
 * outcome belongs in a provider.* event, not in the op's response.
 */

export interface VendorCreateOrderInput {
  fulfilment_request_id: string;
  warehouse_key: string;
  order_id: string;
  lines: Array<{ line_id: string; sku: string; quantity: number }>;
}

export interface VendorClient {
  createOrder(input: VendorCreateOrderInput): Promise<{ provider_ref: string }>;
  cancelOrder(input: { provider_ref: string; reason: string }): Promise<{ accepted: boolean; reason?: string }>;
  readonly calls: number;
}

export function createVendor(): VendorClient {
  let calls = 0;
  return {
    async createOrder(input) {
      calls += 1;
      // TODO: POST to the warehouse and return its id for this request.
      return { provider_ref: 'TODO_' + input.fulfilment_request_id };
    },
    async cancelOrder() {
      calls += 1;
      // TODO: ask the warehouse to cancel. Answer whether it took the request,
      // not whether the order is cancelled: that arrives as an event.
      return { accepted: true };
    },
    get calls() {
      return calls;
    },
  };
}
`;

  files['src/lib/deps.ts'] = `/**
 * ${name} - what the handlers depend on, resolved from env.
 *
 * On the platform \`env.DB\` is always bound, so handlers run against the
 * per-install D1 table. With no DB the app falls back to a module-level
 * in-memory store, which is how the conformance harness and the unit tests
 * drive the shipped handler map. The fallback is unreachable in production:
 * the runtime binds D1 before the first dispatch.
 */

import { d1Store, memoryStore, type RequestStore } from './store';
import { createVendor, type VendorClient } from './vendor';
import type { ${pascal}Env } from './env';

export interface ${pascal}Deps {
  store: RequestStore;
  vendor: VendorClient;
  now(): string;
}

let fallback: ${pascal}Deps | undefined;
let d1Vendor: VendorClient | undefined;

export function depsFor(env: ${pascal}Env): ${pascal}Deps {
  if (env.DB) {
    d1Vendor ??= createVendor();
    return { store: d1Store(env.DB), vendor: d1Vendor, now: () => new Date().toISOString() };
  }
  fallback ??= { store: memoryStore(), vendor: createVendor(), now: () => new Date().toISOString() };
  return fallback;
}

/** Test helper: a self-contained deps bundle with its own store and vendor. */
export function freshDeps(now: () => string = () => new Date().toISOString()): ${pascal}Deps {
  return { store: memoryStore(), vendor: createVendor(), now };
}
`;

  files[`src/handlers/${slug}-provider.ts`] = `/**
 * ${name} - the fulfilment-hub/fulfilment_provider implementation.
 *
 * Every op here already keeps the contract; what is missing is the vendor.
 * Fill in src/lib/vendor.ts and the warehouse fixture below, and keep
 * \`pnpm test\` green as you go: the conformance suite in
 * __tests__/conformance.test.ts is what tells you the moment a rule breaks.
 *
 * The three rules that are easy to lose:
 *   1. Every write op ACKNOWLEDGES inside the dispatch budget with
 *      accepted | queued | rejected. The real outcome arrives as an event.
 *   2. push_order is IDEMPOTENT on fulfilment_request_id. Read the record
 *      first; a repeat call returns the same provider_ref and never reaches
 *      the warehouse.
 *   3. Money is integer minor units, quantities are integers, timestamps are
 *      ISO 8601 UTC. Convert at the edge, inside this adapter.
 */

import { depsFor, type ${pascal}Deps } from '../lib/deps';
import type { ${pascal}Env } from '../lib/env';

export const ADAPTER_SLUG = '${slug}';
export const INTERFACE_VERSION = '1.0.0';

type Ack = { status: 'accepted' | 'queued' | 'rejected'; provider_ref?: string; reason?: string };

const rejected = (reason: string): Ack => ({ status: 'rejected', reason });

/** TODO: replace with the real warehouse list, or fetch and cache it. */
export const WAREHOUSES = [
  { warehouse_key: 'main', name: 'TODO Main Warehouse', country: 'AU', cutoff_local_time: '14:00', active: true },
] as const;

export function describe() {
  return {
    adapter_slug: ADAPTER_SLUG,
    // TODO: set these to what the vendor can actually do. The hub reads them
    // to choose a path and never discovers a limit from error text, so an
    // optimistic value here becomes a request that hangs waiting for an
    // event that never arrives.
    capabilities: {
      supports_cancel: true,
      supports_split: false,
      supports_hold: false,
      tracking_mode: 'push' as const,
      stock_mode: 'snapshot' as const,
      countries: ['AU'],
    },
  };
}

export function listWarehouses() {
  return { warehouses: WAREHOUSES.map((w) => ({ ...w })) };
}

export interface PushOrderArgs {
  fulfilment_request_id: string;
  order_id: string;
  source_number?: string;
  warehouse_key: string;
  ship_to?: Record<string, unknown>;
  customer_email?: string;
  lines?: Array<{ line_id: string; sku: string; quantity: number }>;
  currency?: string;
  total_minor?: number;
  notes?: string;
  callback_hint?: string;
}

export async function pushOrder(deps: ${pascal}Deps, args: PushOrderArgs): Promise<Ack> {
  if (!args?.fulfilment_request_id) return rejected('fulfilment_request_id is required');
  if (!WAREHOUSES.some((w) => w.warehouse_key === args.warehouse_key)) {
    return rejected('unknown warehouse_key "' + args.warehouse_key + '"');
  }

  // Idempotency, first: the hub's outbox is at-least-once.
  const existing = await deps.store.get(args.fulfilment_request_id);
  if (existing) return { status: 'queued', provider_ref: existing.provider_ref };

  const lines = args.lines ?? [];
  const created = await deps.vendor.createOrder({
    fulfilment_request_id: args.fulfilment_request_id,
    warehouse_key: args.warehouse_key,
    order_id: args.order_id ?? '',
    lines,
  });
  const now = deps.now();
  await deps.store.insert({
    fulfilment_request_id: args.fulfilment_request_id,
    provider_ref: created.provider_ref,
    order_id: args.order_id ?? '',
    warehouse_key: args.warehouse_key,
    lines_json: JSON.stringify(lines),
    stage: 'pushed',
    created_at: now,
    updated_at: now,
  });
  // TODO: if the vendor confirms synchronously you may return 'accepted'
  // here, but the hub still waits for provider.order.accepted, so emit it
  // from wherever the confirmation actually lands (a webhook, a poll).
  return { status: 'queued', provider_ref: created.provider_ref };
}

export async function cancelOrder(
  deps: ${pascal}Deps,
  args: { fulfilment_request_id: string; provider_ref?: string; reason?: string },
): Promise<Ack> {
  const row = await deps.store.get(args?.fulfilment_request_id ?? '');
  if (!row) return rejected('no request ' + args?.fulfilment_request_id);
  if (row.stage === 'shipped') return rejected('already shipped');
  const outcome = await deps.vendor.cancelOrder({
    provider_ref: row.provider_ref,
    reason: args?.reason ?? '',
  });
  if (!outcome.accepted) return rejected(outcome.reason ?? 'the warehouse refused the cancellation');
  await deps.store.setStage(row.fulfilment_request_id, 'cancelled', deps.now());
  // Acknowledged, not done: provider.order.cancelled follows.
  return { status: 'accepted' };
}

const STAGE_TO_STATUS: Record<string, string> = {
  pushed: 'pending',
  accepted: 'accepted',
  rejected: 'rejected',
  shipped: 'shipped',
  cancelled: 'cancelled',
};

export async function getOrderStatus(
  deps: ${pascal}Deps,
  args: { fulfilment_request_id: string; provider_ref?: string },
) {
  const row = await deps.store.get(args?.fulfilment_request_id ?? '');
  if (!row) return { status: 'unknown', provider_status_raw: 'NOT_FOUND' };
  // TODO: read the live status from the vendor and map it onto the hub's
  // vocabulary here. Do not pass the vendor's own word through as \`status\`.
  return { status: STAGE_TO_STATUS[row.stage] ?? 'unknown', provider_status_raw: row.stage.toUpperCase() };
}

export function getStock(deps: ${pascal}Deps, args: { warehouse_key?: string; skus?: string[] }) {
  // TODO: read levels from the vendor. Quantities are INTEGERS and
  // snapshot_at is ISO 8601 UTC; convert at this edge if the vendor differs.
  const snapshotAt = deps.now();
  const warehouseKey = args?.warehouse_key ?? WAREHOUSES[0].warehouse_key;
  const levels = (args?.skus ?? []).map((sku) => ({
    provider_adapter: ADAPTER_SLUG,
    warehouse_key: warehouseKey,
    sku,
    on_hand: 0,
    reserved: 0,
    held: 0,
    snapshot_at: snapshotAt,
  }));
  return { levels };
}

export function health() {
  // TODO: report real credential and breaker state. The hub stops routing to
  // a warehouse whose health says it is down, so a hard-coded ok hides an
  // outage behind a growing pile of stuck requests.
  return { ok: true, credentials_ok: true, breaker_open: false, detail: 'TODO: real health check' };
}

// The handler map the runtime dispatches, and the conformance harness drives.
// Tool names are \`<slug_with_underscores>_<op>\`, the only spelling publish
// accepts for a provides-tagged tool.
export default {
  ${slugU}_describe: () => describe(),
  ${slugU}_list_warehouses: () => listWarehouses(),
  ${slugU}_push_order: (args: PushOrderArgs, env: ${pascal}Env) => pushOrder(depsFor(env), args),
  ${slugU}_cancel_order: (
    args: { fulfilment_request_id: string; provider_ref?: string; reason?: string },
    env: ${pascal}Env,
  ) => cancelOrder(depsFor(env), args),
  ${slugU}_get_order_status: (
    args: { fulfilment_request_id: string; provider_ref?: string },
    env: ${pascal}Env,
  ) => getOrderStatus(depsFor(env), args),
  ${slugU}_get_stock: (args: { warehouse_key?: string; skus?: string[] }, env: ${pascal}Env) =>
    getStock(depsFor(env), args),
  ${slugU}_health: () => health(),
};
`;

  files['__tests__/__helpers__/fake-env.ts'] = fakeEnvTs({ pascal, name });

  files['__tests__/conformance.test.ts'] = conformanceTestTs({
    slug,
    role: 'fulfilment_provider',
    handlerImport: `../src/handlers/${slug}-provider`,
    fixtures: `  // The stand-in vendor counts its calls, which is what proves the repeat
  // push_order was served from the idempotency record.
  vendorCalls: () => envDeps(env).vendor.calls,
  fixtures: {
    // TODO: point these at ids the real vendor knows once it is wired up.
    push_order: { warehouse_key: 'main' },
    get_stock: { warehouse_key: 'main', skus: ['TODO-SKU-1'] },
  },
`,
  }).replace(
    "import { fakeEnv } from './__helpers__/fake-env';",
    "import { fakeEnv, envDeps } from './__helpers__/fake-env';",
  );

  files['src/app/layout.tsx'] = layoutTsx({ name });
  files['src/app/page.tsx'] = pageTsx({
    name,
    interfaceId: 'fulfilment-hub/fulfilment_provider',
    blurb: 'The hub routes fulfilment requests here; this app pushes them to the warehouse and reports the outcome as events.',
  });

  files['README.md'] = adapterReadme({ slug, name, role: 'fulfilment_provider' });

  return files;
}

// ---------------------------------------------------------------------------
// order-source files
// ---------------------------------------------------------------------------

function orderSourceFiles({ slug, slugU, name, pascal }) {
  const files = {};

  files['migrations/0001_init.sql'] = `-- Per-install D1 schema for the ${name} fulfilment-hub adapter.
--
-- IMMUTABLE once shipped. Schema changes go in new numbered files.
--
-- The columns are named after the contract's canonical \`order\` and
-- \`order_line\` fields on purpose: an order source's job is to hand the hub
-- those exact shapes, and a store that keeps some other model has to
-- translate on every read, which is where field drift starts.
--
-- Do NOT add a per-event audit table here. D1 charges per row written; use
-- env.SPRIGR.log() for telemetry and keep D1 for state.

CREATE TABLE ${slugU}_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ${slugU}_orders (
  source_ref      TEXT PRIMARY KEY,
  source_number   TEXT NOT NULL,
  status          TEXT NOT NULL,
  placed_at       TEXT NOT NULL,
  currency        TEXT NOT NULL,
  total_minor     INTEGER NOT NULL,
  customer_email  TEXT NOT NULL DEFAULT '',
  ship_to_json    TEXT NOT NULL DEFAULT '{}',
  tags_json       TEXT NOT NULL DEFAULT '[]',
  hold_reason     TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL
);

CREATE TABLE ${slugU}_lines (
  source_line_ref    TEXT PRIMARY KEY,
  source_ref         TEXT NOT NULL,
  line_id            TEXT NOT NULL,
  sku                TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  quantity           INTEGER NOT NULL,
  unit_price_minor   INTEGER NOT NULL,
  currency           TEXT NOT NULL,
  requires_shipping  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX ${slugU}_lines_by_order ON ${slugU}_lines (source_ref);
`;

  files['src/lib/env.ts'] = envTs({ slugU, name, pascal, eventNoun: 'source.*' });

  files['src/lib/store.ts'] = `/**
 * ${name} - the order cache.
 *
 * Two implementations of one interface: the per-install D1 tables the
 * platform binds, and an in-memory map carrying one fixture order. The
 * in-memory one is what lets the conformance harness drive the REAL handler
 * map with no D1 behind it, and the fixture is what makes \`get_order\`
 * exercise its found path rather than its miss path.
 *
 * TODO: a real adapter usually reads the selling system's API directly and
 * caches only what it must. Keep the canonical field names either way.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export interface OrderRecord {
  source_ref: string;
  source_number: string;
  status: string;
  placed_at: string;
  currency: string;
  total_minor: number;
  customer_email: string;
  ship_to_json: string;
  tags_json: string;
  hold_reason: string;
  updated_at: string;
}

export interface LineRecord {
  source_line_ref: string;
  source_ref: string;
  line_id: string;
  sku: string;
  title: string;
  quantity: number;
  unit_price_minor: number;
  currency: string;
  requires_shipping: boolean;
}

export interface OrderStore {
  getOrder(sourceRef: string): Promise<OrderRecord | null>;
  putOrder(order: OrderRecord): Promise<void>;
  listLines(sourceRef: string): Promise<LineRecord[]>;
  putLines(lines: readonly LineRecord[]): Promise<void>;
}

/** TODO: replace with an order the selling system actually has. */
export const FIXTURE_ORDER: OrderRecord = {
  source_ref: 'TODO_ORDER_1',
  source_number: 'TODO-1001',
  status: 'received',
  placed_at: '2026-01-01T00:00:00Z',
  currency: 'AUD',
  total_minor: 1500,
  customer_email: 'buyer@example.test',
  ship_to_json: '{"line1":"1 Test Street","city":"Brisbane","country":"AU"}',
  tags_json: '[]',
  hold_reason: '',
  updated_at: '2026-01-01T00:00:00Z',
};

export const FIXTURE_LINES: readonly LineRecord[] = [
  {
    source_line_ref: 'TODO_ORDER_1_L1',
    source_ref: 'TODO_ORDER_1',
    line_id: 'TODO_ORDER_1_L1',
    sku: 'TODO-SKU-1',
    title: 'TODO item',
    quantity: 1,
    unit_price_minor: 1500,
    currency: 'AUD',
    requires_shipping: true,
  },
];

const boolIn = (v: boolean) => (v ? 1 : 0);
const boolOut = (v: unknown) => v === 1 || v === true;

export function d1Store(db: D1Like): OrderStore {
  return {
    async getOrder(sourceRef) {
      return db
        .prepare(
          \`SELECT source_ref, source_number, status, placed_at, currency, total_minor,
                  customer_email, ship_to_json, tags_json, hold_reason, updated_at
             FROM ${slugU}_orders WHERE source_ref = ?\`,
        )
        .bind(sourceRef)
        .first<OrderRecord>();
    },
    async putOrder(order) {
      await db
        .prepare(
          \`INSERT INTO ${slugU}_orders
             (source_ref, source_number, status, placed_at, currency, total_minor,
              customer_email, ship_to_json, tags_json, hold_reason, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_ref) DO UPDATE SET
             status = excluded.status, total_minor = excluded.total_minor,
             tags_json = excluded.tags_json, hold_reason = excluded.hold_reason,
             updated_at = excluded.updated_at\`,
        )
        .bind(
          order.source_ref, order.source_number, order.status, order.placed_at, order.currency,
          order.total_minor, order.customer_email, order.ship_to_json, order.tags_json,
          order.hold_reason, order.updated_at,
        )
        .run();
    },
    async listLines(sourceRef) {
      const res = await db
        .prepare(
          \`SELECT source_line_ref, source_ref, line_id, sku, title, quantity,
                  unit_price_minor, currency, requires_shipping
             FROM ${slugU}_lines WHERE source_ref = ? ORDER BY source_line_ref\`,
        )
        .bind(sourceRef)
        .all<LineRecord & { requires_shipping: unknown }>();
      return res.results.map((r) => ({ ...r, requires_shipping: boolOut(r.requires_shipping) }));
    },
    async putLines(lines) {
      for (const line of lines) {
        await db
          .prepare(
            \`INSERT INTO ${slugU}_lines
               (source_line_ref, source_ref, line_id, sku, title, quantity,
                unit_price_minor, currency, requires_shipping)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_line_ref) DO NOTHING\`,
          )
          .bind(
            line.source_line_ref, line.source_ref, line.line_id, line.sku, line.title,
            line.quantity, line.unit_price_minor, line.currency, boolIn(line.requires_shipping),
          )
          .run();
      }
    },
  };
}

export function memoryStore(): OrderStore {
  const orders = new Map<string, OrderRecord>([[FIXTURE_ORDER.source_ref, { ...FIXTURE_ORDER }]]);
  const lines = new Map<string, LineRecord>(FIXTURE_LINES.map((l) => [l.source_line_ref, { ...l }]));
  return {
    async getOrder(sourceRef) {
      return orders.get(sourceRef) ?? null;
    },
    async putOrder(order) {
      orders.set(order.source_ref, { ...order });
    },
    async listLines(sourceRef) {
      return [...lines.values()].filter((l) => l.source_ref === sourceRef).map((l) => ({ ...l }));
    },
    async putLines(next) {
      for (const line of next) if (!lines.has(line.source_line_ref)) lines.set(line.source_line_ref, { ...line });
    },
  };
}
`;

  files['src/lib/deps.ts'] = `/**
 * ${name} - what the handlers depend on, resolved from env.
 *
 * On the platform \`env.DB\` is always bound, so handlers run against the
 * per-install D1 tables. With no DB the app falls back to a module-level
 * in-memory store carrying the fixture order, which is how the conformance
 * harness and the unit tests drive the shipped handler map. The fallback is
 * unreachable in production: the runtime binds D1 before the first dispatch.
 */

import { d1Store, memoryStore, type OrderStore } from './store';
import type { ${pascal}Env } from './env';

export interface ${pascal}Deps {
  store: OrderStore;
  now(): string;
}

let fallback: ${pascal}Deps | undefined;

export function depsFor(env: ${pascal}Env): ${pascal}Deps {
  if (env.DB) return { store: d1Store(env.DB), now: () => new Date().toISOString() };
  fallback ??= { store: memoryStore(), now: () => new Date().toISOString() };
  return fallback;
}

/** Test helper: a self-contained deps bundle with its own store. */
export function freshDeps(now: () => string = () => new Date().toISOString()): ${pascal}Deps {
  return { store: memoryStore(), now };
}
`;

  files[`src/handlers/${slug}-order-source.ts`] = `/**
 * ${name} - the fulfilment-hub/order_source implementation.
 *
 * Every op here already keeps the contract; what is missing is the selling
 * system. Replace the store reads and the TODO stubs with real API calls and
 * keep \`pnpm test\` green as you go: the conformance suite in
 * __tests__/conformance.test.ts is what tells you the moment a rule breaks.
 *
 * The rules that are easy to lose:
 *   1. Every write op ACKNOWLEDGES inside the dispatch budget with
 *      accepted | rejected | error, and carries a reason when it rejects or
 *      errors. \`error\` means the hub may retry; \`rejected\` is terminal.
 *   2. \`order_id\` goes out EMPTY. The hub assigns it.
 *   3. Money is integer minor units, quantities are integers, timestamps are
 *      ISO 8601 UTC. Convert at the edge, inside this adapter.
 *   4. \`source.request.submitted\` is THE routing trigger. Emit it from
 *      wherever the selling system tells you a fulfilment is ready (usually a
 *      webhook), or the hub never routes anything.
 */

import { depsFor, type ${pascal}Deps } from '../lib/deps';
import { safeEmit, type ${pascal}Env } from '../lib/env';
import type { LineRecord, OrderRecord } from '../lib/store';

export const ADAPTER_SLUG = '${slug}';
export const CHANNEL = 'TODO';
export const INTERFACE_VERSION = '1.0.0';

/**
 * An order source acks with accepted | rejected | error. \`error\` is a
 * transient failure the hub may retry; \`rejected\` is terminal. The provider
 * interface uses a different set (accepted | queued | rejected), so do not
 * copy one adapter's spelling into the other.
 */
type Ack = {
  status: 'accepted' | 'rejected' | 'error';
  reason?: string;
  source_location_ref?: string;
  source_fulfilment_ref?: string;
  new_source_request_ref?: string;
};

const errored = (reason: string): Ack => ({ status: 'error', reason });

const rejected = (reason: string): Ack => ({ status: 'rejected', reason });

/** TODO: replace with the selling system's real locations. */
export const LOCATIONS = [
  { source_location_ref: 'TODO_LOC_1', name: 'TODO Location', country: 'AU', active: true },
] as const;

export function toCanonicalOrder(row: OrderRecord): Record<string, unknown> {
  return {
    order_id: '', // the hub assigns it
    source_adapter: ADAPTER_SLUG,
    source_ref: row.source_ref,
    source_number: row.source_number,
    channel: CHANNEL,
    status: row.status,
    placed_at: row.placed_at,
    currency: row.currency,
    total_minor: row.total_minor,
    customer_email: row.customer_email,
    ship_to_json: row.ship_to_json,
    tags_json: row.tags_json,
    hold_reason: row.hold_reason,
    updated_at: row.updated_at,
  };
}

export function toCanonicalLine(row: LineRecord): Record<string, unknown> {
  return {
    order_id: '',
    line_id: row.line_id,
    source_line_ref: row.source_line_ref,
    sku: row.sku,
    title: row.title,
    quantity: row.quantity,
    unit_price_minor: row.unit_price_minor,
    currency: row.currency,
    requires_shipping: row.requires_shipping,
  };
}

export function describe() {
  return {
    adapter_slug: ADAPTER_SLUG,
    channel: CHANNEL,
    // TODO: set these to what the selling system can actually do. The hub
    // picks its hold, split and stock paths from these values.
    capabilities: {
      supports_hold: false,
      supports_split: false,
      supports_cancel: true,
      supports_stock_write: false,
      request_model: 'fulfilment_orders' as const,
    },
  };
}

export function listLocations() {
  return { locations: LOCATIONS.map((l) => ({ ...l })) };
}

export function registerLocation(args: { warehouse_key: string; name: string; country: string }): Ack {
  if (!args?.warehouse_key) return rejected('warehouse_key is required');
  // TODO: create the location in the selling system and return its id.
  return rejected('register_location is not implemented yet');
}

export async function getOrder(deps: ${pascal}Deps, args: { source_ref: string }) {
  // TODO: read from the selling system's API. Return the CANONICAL shapes.
  const row = await deps.store.getOrder(args?.source_ref ?? '');
  if (!row) return { found: false };
  const lines = await deps.store.listLines(row.source_ref);
  return { found: true, order: toCanonicalOrder(row), lines: lines.map(toCanonicalLine) };
}

export function acceptRequest(args: { source_request_ref: string }): Ack {
  if (!args?.source_request_ref) return rejected('source_request_ref is required');
  // TODO: accept the fulfilment order in the selling system.
  return { status: 'accepted' };
}

export function rejectRequest(args: { source_request_ref: string; reason: string }): Ack {
  if (!args?.source_request_ref) return rejected('source_request_ref is required');
  // TODO: reject the fulfilment order in the selling system.
  return { status: 'accepted' };
}

export function markShipped(args: {
  source_request_ref: string;
  source_ref: string;
  carrier: string;
  tracking_number: string;
  tracking_url?: string;
  lines?: Array<{ source_line_ref: string; quantity: number }>;
  notify_customer?: boolean;
}): Ack {
  if (!args?.carrier || !args?.tracking_number) {
    return rejected('carrier and tracking_number are required to mark a request shipped');
  }
  // TODO: create the fulfilment in the selling system and return its id.
  return rejected('mark_shipped is not implemented yet');
}

export function hold(args: { source_request_ref: string; reason: string }): Ack {
  // TODO: hold the fulfilment order, or report the capability honestly in
  // describe() and keep refusing here.
  return describe().capabilities.supports_hold
    ? { status: 'accepted' }
    : rejected('this selling system does not support holds (see describe().capabilities)');
}

export async function release(env: ${pascal}Env, args: { source_request_ref: string }): Promise<Ack> {
  if (!describe().capabilities.supports_hold) {
    return rejected('this selling system does not support holds (see describe().capabilities)');
  }
  // TODO: release the hold, then tell the hub it is routable again.
  const announced = await safeEmit(env, 'source.request.hold_released', {
    adapter_slug: ADAPTER_SLUG,
    interface_version: INTERFACE_VERSION,
    source_ref: '',
    source_request_ref: args?.source_request_ref ?? '',
  });
  // A release the hub never hears about is a request that stops moving, so
  // this is \`error\` (retry me), not \`rejected\` (give up).
  if (!announced.emitted) return errored('released, but the hold_released event did not reach the hub: ' + (announced.reason ?? 'unknown'));
  return { status: 'accepted' };
}

export function cancel(args: { source_request_ref: string; reason: string }): Ack {
  if (!args?.source_request_ref) return rejected('source_request_ref is required');
  // TODO: cancel in the selling system.
  return { status: 'accepted' };
}

export function split(args: {
  source_request_ref: string;
  lines: Array<{ source_line_ref: string; quantity: number }>;
}): Ack {
  if (!describe().capabilities.supports_split) {
    return rejected('this selling system does not support splitting (see describe().capabilities)');
  }
  // TODO: split and return the new request ref.
  return rejected('split is not implemented yet');
}

export function setStockLevel(args: { source_location_ref: string; sku: string; on_hand: number }): Ack {
  if (!describe().capabilities.supports_stock_write) {
    return rejected('this selling system does not accept stock writes (see describe().capabilities)');
  }
  if (!Number.isInteger(args?.on_hand)) return rejected('on_hand must be an integer');
  // TODO: write the level back.
  return { status: 'accepted' };
}

export function addNote(args: { source_ref: string; note: string; tags?: string[] }): Ack {
  if (!args?.source_ref || !args?.note) return rejected('source_ref and note are required');
  // TODO: APPEND the note in the selling system. Never replace what is
  // already on the order; a note the hub wrote and cannot read back is worse
  // than a failed write.
  return rejected('add_note is not implemented yet');
}

// The handler map the runtime dispatches, and the conformance harness drives.
// Tool names are \`<slug_with_underscores>_<op>\`, the only spelling publish
// accepts for a provides-tagged tool.
export default {
  ${slugU}_describe: () => describe(),
  ${slugU}_list_locations: () => listLocations(),
  ${slugU}_register_location: (args: { warehouse_key: string; name: string; country: string }) =>
    registerLocation(args),
  ${slugU}_get_order: (args: { source_ref: string }, env: ${pascal}Env) => getOrder(depsFor(env), args),
  ${slugU}_accept_request: (args: { source_request_ref: string }) => acceptRequest(args),
  ${slugU}_reject_request: (args: { source_request_ref: string; reason: string }) => rejectRequest(args),
  ${slugU}_mark_shipped: (args: Parameters<typeof markShipped>[0]) => markShipped(args),
  ${slugU}_hold: (args: { source_request_ref: string; reason: string }) => hold(args),
  ${slugU}_release: (args: { source_request_ref: string }, env: ${pascal}Env) => release(env, args),
  ${slugU}_cancel: (args: { source_request_ref: string; reason: string }) => cancel(args),
  ${slugU}_split: (args: Parameters<typeof split>[0]) => split(args),
  ${slugU}_set_stock_level: (args: { source_location_ref: string; sku: string; on_hand: number }) =>
    setStockLevel(args),
  ${slugU}_add_note: (args: { source_ref: string; note: string; tags?: string[] }) => addNote(args),
};
`;

  files['__tests__/__helpers__/fake-env.ts'] = fakeEnvTs({ pascal, name });

  files['__tests__/conformance.test.ts'] = conformanceTestTs({
    slug,
    role: 'order_source',
    handlerImport: `../src/handlers/${slug}-order-source`,
    fixtures: `  fixtures: {
    // TODO: point this at an order the selling system actually has. The
    // harness fails \`get_order.resolves_the_fixture\` until it resolves,
    // because a found:false answer never exercises the canonical shapes.
    get_order: { source_ref: FIXTURE_ORDER.source_ref },
  },
`,
  }).replace(
    "import { fakeEnv } from './__helpers__/fake-env';",
    "import { fakeEnv } from './__helpers__/fake-env';\nimport { FIXTURE_ORDER } from '../src/lib/store';",
  );

  files['src/app/layout.tsx'] = layoutTsx({ name });
  files['src/app/page.tsx'] = pageTsx({
    name,
    interfaceId: 'fulfilment-hub/order_source',
    blurb: 'It hands the hub orders from the selling system and writes fulfilments and stock back.',
  });

  files['README.md'] = adapterReadme({ slug, name, role: 'order_source' });

  return files;
}

function adapterReadme({ slug, name, role }) {
  const isProvider = role === 'fulfilment_provider';
  const interfaceId = isProvider ? 'fulfilment-hub/fulfilment_provider' : 'fulfilment-hub/order_source';
  const opCount = isProvider ? 7 : 13;
  return `# ${name} (\`${slug}\`)

An implementer of **\`${interfaceId}\`** v1.0.0. Scaffolded by \`pnpm create:app ${slug} --template ${isProvider ? 'fulfilment-provider' : 'order-source'}\`.

TODO: say which ${isProvider ? 'warehouse or 3PL' : 'selling system'} this connects to, and any publisher-side setup.

## What is already done

- **The manifest claims all ${opCount} ops** of the interface with \`provides\` tags pinned at \`1.0.0\`, tool names spelled \`<slug_with_underscores>_<op>\`, \`effects: 'write'\` on the write ops, and the contract events declared in \`events.emits[]\`.
- **The handler map keeps the contract**: async acks (\`${isProvider ? 'accepted | queued | rejected' : 'accepted | rejected | error'}\`), ${isProvider ? 'an idempotent `push_order` keyed on `fulfilment_request_id`, ' : '`order_id` left empty for the hub, '}integer minor units, integer quantities, ISO 8601 UTC stamps.
- **\`pnpm test\` is green from the first commit** and runs the whole conformance suite. Keep it green as you fill in the vendor: when it goes red, the check name is the contract rule you broke.

## What you have to do

1. Fill in the TODOs in \`sprigr-app.json\` (description, tags, \`permissions.network_domains\`).
2. ${isProvider ? 'Implement `src/lib/vendor.ts` against the real warehouse API. Keep the `calls` counter: the harness reads it to prove a repeat push never reached the warehouse.' : "Replace the store reads in `src/handlers/" + slug + "-order-source.ts` with the selling system's API, and the fixture order in `src/lib/store.ts` with one it actually has."}
3. Set \`describe().capabilities\` to what the vendor can actually do. The hub reads it to choose a path and never infers a limit from error text, so an optimistic value there becomes a request that waits forever for an event that never arrives.
4. **Emit the events.** ${isProvider ? 'The ops only acknowledge; the hub learns every outcome from `provider.order.accepted`, `provider.shipment.created` and the rest. Wire them to wherever the warehouse actually tells you (a webhook, a poll).' : '`source.request.submitted` is THE routing trigger. Emit it from the selling system webhook that says a fulfilment is ready, or the hub never routes anything.'}
5. Add unit tests for the vendor mapping. The conformance suite proves you keep the CONTRACT; it cannot prove you read the vendor correctly.

## Reference

- The contract: [\`docs/interfaces/fulfilment-hub-v1.md\`](../../docs/interfaces/fulfilment-hub-v1.md) in sprigr-app-kit.
- The harness: [\`@sprigr/apps-fulfilment-conformance\`](https://www.npmjs.com/package/@sprigr/apps-fulfilment-conformance).
- Worked mocks: \`examples/${isProvider ? 'mock-warehouse' : 'mock-order-source'}\` in sprigr-app-kit, which implement every op end to end.
`;
}

export function adapterNextSteps({ slug, name, template }) {
  const isProvider = template === 'fulfilment-provider';
  return `
[create-app] ${slug} implements ${isProvider ? 'fulfilment-hub/fulfilment_provider' : 'fulfilment-hub/order_source'} v1.0.0. Next steps:

  1. pnpm install                      # register the new workspace package
  2. pnpm -F ${slug} test              # the conformance suite, green from here
  3. Fill in sprigr-app.json TODOs     # description, tags, network_domains
  4. ${isProvider ? 'Implement src/lib/vendor.ts against the real warehouse API' : "Replace the store reads with the selling system's API"}
  5. Set describe().capabilities to what the vendor can actually do
  6. Emit the events: ${isProvider ? 'the ops only acknowledge, the hub learns outcomes from provider.* events' : 'source.request.submitted is THE routing trigger'}

  The contract is docs/interfaces/fulfilment-hub-v1.md; the worked mock is
  examples/${isProvider ? 'mock-warehouse' : 'mock-order-source'}.
`;
}
