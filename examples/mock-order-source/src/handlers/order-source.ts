/**
 * mock-order-source - the fulfilment-hub/order_source implementation.
 *
 * A deterministic stand-in selling system. Every op reads and writes this
 * install's own D1 (or, with no DB bound, the in-memory store carrying the
 * same seed), so the hub can be driven end to end with no Shopify, no
 * Magento and no credentials.
 *
 * `mock_order_source_place_order` is the lever: it creates an order and a
 * fulfilment request and emits `source.order.created` followed by
 * `source.request.submitted`, which is THE routing trigger the hub
 * subscribes to.
 */

import { depsFor, type OrderSourceDeps } from '../lib/deps';
import { report, safeEmit, type EmitOutcome, type MockOrderSourceEnv } from '../lib/env';
import {
  SEED_LOCATIONS,
  type LineRecord,
  type OrderRecord,
  type RequestRecord,
} from '../lib/records';

export const ADAPTER_SLUG = 'mock-order-source';
export const CHANNEL = 'mock';
export const INTERFACE_VERSION = '1.0.0';

/**
 * An order source acks with accepted | rejected | error (contract section 7,
 * clarification 2). `error` is a transient failure the hub may retry;
 * `rejected` is terminal. The provider interface uses a DIFFERENT set
 * (accepted | queued | rejected), so the two are not interchangeable.
 */
type Ack = {
  status: 'accepted' | 'rejected' | 'error';
  reason?: string;
  source_location_ref?: string;
  source_fulfilment_ref?: string;
  new_source_request_ref?: string;
};

const rejected = (reason: string): Ack => ({ status: 'rejected', reason });
const errored = (reason: string): Ack => ({ status: 'error', reason });

/** The canonical `order` record, as the contract's section 2 defines it. */
function toCanonicalOrder(row: OrderRecord): Record<string, unknown> {
  return {
    // The hub assigns order_id; an order source leaves it empty.
    order_id: '',
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

function toCanonicalLine(row: LineRecord): Record<string, unknown> {
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
    capabilities: {
      supports_hold: true,
      supports_split: true,
      supports_cancel: true,
      supports_stock_write: true,
      request_model: 'fulfilment_orders' as const,
    },
  };
}

export async function listLocations(deps: OrderSourceDeps) {
  const rows = await deps.store.listLocations();
  return {
    locations: rows.map((l) => ({
      source_location_ref: l.source_location_ref,
      name: l.name,
      country: l.country,
      active: l.active,
    })),
  };
}

export async function registerLocation(
  deps: OrderSourceDeps,
  args: { warehouse_key: string; name: string; country: string; address?: Record<string, unknown> },
): Promise<Ack> {
  if (!args?.warehouse_key) return rejected('warehouse_key is required');
  const ref = `mos_loc_${args.warehouse_key}`;
  await deps.store.putLocation({
    source_location_ref: ref,
    name: args.name || args.warehouse_key,
    country: (args.country || 'AU').toUpperCase(),
    active: true,
  });
  return { status: 'accepted', source_location_ref: ref };
}

export async function getOrder(deps: OrderSourceDeps, args: { source_ref: string }) {
  const row = await deps.store.getOrder(args?.source_ref ?? '');
  if (!row) return { found: false };
  const lines = await deps.store.listLines(row.source_ref);
  return { found: true, order: toCanonicalOrder(row), lines: lines.map(toCanonicalLine) };
}

/**
 * The request lifecycle ops all land here. The mock records the new state
 * and acknowledges; it deliberately does NOT enforce a state machine,
 * because the hub owns that and a fixture that second-guesses it would make
 * the hub's own transitions untestable.
 */
async function transition(
  deps: OrderSourceDeps,
  ref: string,
  state: string,
  patch: Partial<RequestRecord> = {},
): Promise<RequestRecord | null> {
  const row = await deps.store.getRequest(ref);
  if (!row) return null;
  const next: RequestRecord = { ...row, ...patch, state, updated_at: deps.now() };
  await deps.store.putRequest(next);
  return next;
}

export async function acceptRequest(deps: OrderSourceDeps, args: { source_request_ref: string }): Promise<Ack> {
  const row = await transition(deps, args?.source_request_ref ?? '', 'accepted');
  return row ? { status: 'accepted' } : rejected(`no request ${args?.source_request_ref}`);
}

export async function rejectRequest(
  deps: OrderSourceDeps,
  args: { source_request_ref: string; reason: string },
): Promise<Ack> {
  const row = await transition(deps, args?.source_request_ref ?? '', 'rejected', { reason: args?.reason ?? '' });
  return row ? { status: 'accepted' } : rejected(`no request ${args?.source_request_ref}`);
}

export async function markShipped(
  deps: OrderSourceDeps,
  args: {
    source_request_ref: string;
    source_ref: string;
    carrier: string;
    tracking_number: string;
    tracking_url?: string;
    lines?: Array<{ source_line_ref: string; quantity: number }>;
    notify_customer?: boolean;
  },
): Promise<Ack> {
  if (!args?.carrier || !args?.tracking_number) {
    return rejected('carrier and tracking_number are required to mark a request shipped');
  }
  const sourceFulfilmentRef = `mos_sf_${args.source_request_ref}`;
  const row = await transition(deps, args.source_request_ref, 'shipped', {
    source_fulfilment_ref: sourceFulfilmentRef,
  });
  if (!row) return rejected(`no request ${args.source_request_ref}`);
  const order = await deps.store.getOrder(args.source_ref);
  if (order) {
    await deps.store.putOrder({ ...order, status: 'shipped', updated_at: deps.now() });
  }
  return { status: 'accepted', source_fulfilment_ref: sourceFulfilmentRef };
}

export async function hold(
  deps: OrderSourceDeps,
  args: { source_request_ref: string; reason: string },
): Promise<Ack> {
  const row = await transition(deps, args?.source_request_ref ?? '', 'held', { reason: args?.reason ?? '' });
  if (!row) return rejected(`no request ${args?.source_request_ref}`);
  const order = await deps.store.getOrder(row.source_ref);
  if (order) {
    await deps.store.putOrder({
      ...order,
      status: 'held',
      hold_reason: args?.reason ?? '',
      updated_at: deps.now(),
    });
  }
  return { status: 'accepted' };
}

export async function release(
  env: MockOrderSourceEnv,
  deps: OrderSourceDeps,
  args: { source_request_ref: string },
): Promise<Ack> {
  const row = await transition(deps, args?.source_request_ref ?? '', 'submitted', { reason: '' });
  if (!row) return rejected(`no request ${args?.source_request_ref}`);
  const order = await deps.store.getOrder(row.source_ref);
  if (order) {
    await deps.store.putOrder({ ...order, status: 'received', hold_reason: '', updated_at: deps.now() });
  }
  // A released hold is a routing trigger again, so the hub hears about it.
  // A release the hub never hears about is a request that stops moving, so
  // an undelivered event is `error` (the hub may retry), not `rejected`.
  const announced = await safeEmit(env, 'source.request.hold_released', {
    adapter_slug: ADAPTER_SLUG,
    interface_version: INTERFACE_VERSION,
    source_ref: row.source_ref,
    source_request_ref: row.source_request_ref,
  });
  if (!announced.emitted) {
    return errored(`released, but source.request.hold_released did not reach the hub: ${announced.reason ?? 'unknown'}`);
  }
  return { status: 'accepted' };
}

export async function cancel(
  env: MockOrderSourceEnv,
  deps: OrderSourceDeps,
  args: { source_request_ref: string; reason: string },
): Promise<Ack> {
  const row = await transition(deps, args?.source_request_ref ?? '', 'cancelled', { reason: args?.reason ?? '' });
  if (!row) return rejected(`no request ${args?.source_request_ref}`);
  await safeEmit(env, 'source.request.cancellation_submitted', {
    adapter_slug: ADAPTER_SLUG,
    interface_version: INTERFACE_VERSION,
    source_ref: row.source_ref,
    source_request_ref: row.source_request_ref,
    reason: args?.reason ?? '',
  });
  return { status: 'accepted' };
}

export async function split(
  env: MockOrderSourceEnv,
  deps: OrderSourceDeps,
  args: { source_request_ref: string; lines: Array<{ source_line_ref: string; quantity: number }> },
): Promise<Ack> {
  const row = await deps.store.getRequest(args?.source_request_ref ?? '');
  if (!row) return rejected(`no request ${args?.source_request_ref}`);
  const moving = Array.isArray(args?.lines) ? args.lines : [];
  if (moving.length === 0) return rejected('split needs at least one line');

  const newRef = `${row.source_request_ref}_s${countSuffix(row)}`;
  const original = JSON.parse(row.lines_json) as Array<{ source_line_ref: string; sku: string; quantity: number }>;
  const movingRefs = new Set(moving.map((l) => l.source_line_ref));
  const remaining = original.filter((l) => !movingRefs.has(l.source_line_ref));
  const moved = original
    .filter((l) => movingRefs.has(l.source_line_ref))
    .map((l) => ({ ...l, quantity: moving.find((m) => m.source_line_ref === l.source_line_ref)?.quantity ?? l.quantity }));

  await deps.store.putRequest({ ...row, lines_json: JSON.stringify(remaining), updated_at: deps.now() });
  await deps.store.putRequest({
    source_request_ref: newRef,
    source_ref: row.source_ref,
    source_location_ref: row.source_location_ref,
    state: 'submitted',
    lines_json: JSON.stringify(moved),
    reason: '',
    source_fulfilment_ref: '',
    updated_at: deps.now(),
  });
  // The split half is a new routing trigger.
  await safeEmit(env, 'source.request.submitted', {
    adapter_slug: ADAPTER_SLUG,
    interface_version: INTERFACE_VERSION,
    source_ref: row.source_ref,
    source_request_ref: newRef,
    source_location_ref: row.source_location_ref,
    lines: moved,
  });
  return { status: 'accepted', new_source_request_ref: newRef };
}

/** `_s1`, `_s2`, ... so a second split of the same request gets its own ref. */
function countSuffix(row: RequestRecord): number {
  const lines = JSON.parse(row.lines_json) as unknown[];
  return Math.max(1, lines.length);
}

export async function setStockLevel(
  env: MockOrderSourceEnv,
  deps: OrderSourceDeps,
  args: { source_location_ref: string; sku: string; on_hand: number },
): Promise<Ack> {
  if (!args?.source_location_ref || !args?.sku) return rejected('source_location_ref and sku are required');
  if (!Number.isInteger(args.on_hand)) return rejected(`on_hand must be an integer, got ${String(args.on_hand)}`);
  await deps.store.putStock({
    source_location_ref: args.source_location_ref,
    sku: args.sku,
    on_hand: args.on_hand,
    updated_at: deps.now(),
  });
  await safeEmit(env, 'source.stock.changed', {
    adapter_slug: ADAPTER_SLUG,
    interface_version: INTERFACE_VERSION,
    source_location_ref: args.source_location_ref,
    sku: args.sku,
    on_hand: args.on_hand,
  });
  return { status: 'accepted' };
}

export async function addNote(
  deps: OrderSourceDeps,
  args: { source_ref: string; note: string; tags?: string[] },
): Promise<Ack> {
  const order = await deps.store.getOrder(args?.source_ref ?? '');
  if (!order) return rejected(`no order ${args?.source_ref}`);
  // Append. Nothing here trims the existing notes or the incoming one: a
  // note the hub wrote and cannot read back is worse than a failed write.
  const notes = JSON.parse(order.notes_json) as Array<Record<string, unknown>>;
  notes.push({ note: args?.note ?? '', tags: args?.tags ?? [], at: deps.now() });
  const tags = new Set([...(JSON.parse(order.tags_json) as string[]), ...(args?.tags ?? [])]);
  await deps.store.putOrder({
    ...order,
    notes_json: JSON.stringify(notes),
    tags_json: JSON.stringify([...tags]),
    updated_at: deps.now(),
  });
  return { status: 'accepted' };
}

// ---------------------------------------------------------------------------
// The shakedown lever
// ---------------------------------------------------------------------------

export interface PlaceOrderArgs {
  source_number?: string;
  sku?: string;
  quantity?: number;
  unit_price_minor?: number;
  currency?: string;
  customer_email?: string;
  source_location_ref?: string;
  country?: string;
}

export interface PlaceOrderResult {
  ok: boolean;
  source_ref?: string;
  source_request_ref?: string;
  emitted?: EmitOutcome[];
  reason?: string;
}

/**
 * Create one order with one line and one submitted fulfilment request, then
 * emit `source.order.created` followed by
 * `source.request.submitted`. The second is THE routing trigger: it is
 * what makes the hub choose a provider and push.
 *
 * Ids are derived from `source_number`, so a shakedown knows every id it
 * will see before it runs.
 */
export async function placeOrder(
  env: MockOrderSourceEnv,
  deps: OrderSourceDeps,
  args: PlaceOrderArgs,
): Promise<PlaceOrderResult> {
  const sourceNumber = args?.source_number || `MOS-${Date.now()}`;
  const sourceRef = `mos_${sourceNumber.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  if (await deps.store.getOrder(sourceRef)) {
    return { ok: false, reason: `order ${sourceRef} already exists (source_number must be unique)` };
  }

  const quantity = Number.isInteger(args?.quantity) ? (args!.quantity as number) : 1;
  const unitPriceMinor = Number.isInteger(args?.unit_price_minor) ? (args!.unit_price_minor as number) : 1500;
  const currency = (args?.currency || 'AUD').toUpperCase();
  const locationRef = args?.source_location_ref || SEED_LOCATIONS[0]!.source_location_ref;
  const now = deps.now();

  const order: OrderRecord = {
    source_ref: sourceRef,
    source_number: sourceNumber,
    status: 'received',
    placed_at: now,
    currency,
    total_minor: quantity * unitPriceMinor,
    customer_email: args?.customer_email || 'buyer@example.test',
    ship_to_json: JSON.stringify({
      name: 'Mock Buyer',
      line1: '1 Test Street',
      city: 'Brisbane',
      region: 'QLD',
      postcode: '4000',
      country: (args?.country || 'AU').toUpperCase(),
    }),
    tags_json: '[]',
    notes_json: '[]',
    hold_reason: '',
    updated_at: now,
  };
  const line: LineRecord = {
    source_line_ref: `${sourceRef}_l1`,
    source_ref: sourceRef,
    line_id: `${sourceRef}_l1`,
    sku: args?.sku || 'CONF-SKU-1',
    title: `Mock ${args?.sku || 'CONF-SKU-1'}`,
    quantity,
    unit_price_minor: unitPriceMinor,
    currency,
    requires_shipping: true,
  };
  const requestRef = `${sourceRef}_r1`;
  const requestLines = [{ source_line_ref: line.source_line_ref, sku: line.sku, quantity }];

  await deps.store.putOrder(order);
  await deps.store.putLines([line]);
  await deps.store.putRequest({
    source_request_ref: requestRef,
    source_ref: sourceRef,
    source_location_ref: locationRef,
    state: 'submitted',
    lines_json: JSON.stringify(requestLines),
    reason: '',
    source_fulfilment_ref: '',
    updated_at: now,
  });

  const emitted = [
    await safeEmit(env, 'source.order.created', {
      adapter_slug: ADAPTER_SLUG,
      interface_version: INTERFACE_VERSION,
      order: toCanonicalOrder(order),
      lines: [toCanonicalLine(line)],
    }),
    await safeEmit(env, 'source.request.submitted', {
      adapter_slug: ADAPTER_SLUG,
      interface_version: INTERFACE_VERSION,
      source_ref: sourceRef,
      source_request_ref: requestRef,
      source_location_ref: locationRef,
      lines: requestLines,
    }),
  ];
  await report(env, 'place_order', { source_ref: sourceRef, source_request_ref: requestRef });
  return { ok: true, source_ref: sourceRef, source_request_ref: requestRef, emitted };
}

// ---------------------------------------------------------------------------
// The handler map. Tool names are `<slug_with_underscores>_<op>`.
// ---------------------------------------------------------------------------

export default {
  mock_order_source_describe: () => describe(),
  mock_order_source_list_locations: (_args: unknown, env: MockOrderSourceEnv) => listLocations(depsFor(env)),
  mock_order_source_register_location: (
    args: { warehouse_key: string; name: string; country: string },
    env: MockOrderSourceEnv,
  ) => registerLocation(depsFor(env), args),
  mock_order_source_get_order: (args: { source_ref: string }, env: MockOrderSourceEnv) =>
    getOrder(depsFor(env), args),
  mock_order_source_accept_request: (args: { source_request_ref: string }, env: MockOrderSourceEnv) =>
    acceptRequest(depsFor(env), args),
  mock_order_source_reject_request: (
    args: { source_request_ref: string; reason: string },
    env: MockOrderSourceEnv,
  ) => rejectRequest(depsFor(env), args),
  mock_order_source_mark_shipped: (
    args: Parameters<typeof markShipped>[1],
    env: MockOrderSourceEnv,
  ) => markShipped(depsFor(env), args),
  mock_order_source_hold: (args: { source_request_ref: string; reason: string }, env: MockOrderSourceEnv) =>
    hold(depsFor(env), args),
  mock_order_source_release: (args: { source_request_ref: string }, env: MockOrderSourceEnv) =>
    release(env, depsFor(env), args),
  mock_order_source_cancel: (args: { source_request_ref: string; reason: string }, env: MockOrderSourceEnv) =>
    cancel(env, depsFor(env), args),
  mock_order_source_split: (
    args: { source_request_ref: string; lines: Array<{ source_line_ref: string; quantity: number }> },
    env: MockOrderSourceEnv,
  ) => split(env, depsFor(env), args),
  mock_order_source_set_stock_level: (
    args: { source_location_ref: string; sku: string; on_hand: number },
    env: MockOrderSourceEnv,
  ) => setStockLevel(env, depsFor(env), args),
  mock_order_source_add_note: (
    args: { source_ref: string; note: string; tags?: string[] },
    env: MockOrderSourceEnv,
  ) => addNote(depsFor(env), args),
  mock_order_source_place_order: (args: PlaceOrderArgs, env: MockOrderSourceEnv) =>
    placeOrder(env, depsFor(env), args),
};
