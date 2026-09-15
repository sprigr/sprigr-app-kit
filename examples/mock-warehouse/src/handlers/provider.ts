/**
 * mock-warehouse - the fulfilment-hub/fulfilment_provider implementation.
 *
 * A deterministic stand-in warehouse. It accepts every push, holds the
 * request at `queued`, and only moves when a human or a shakedown script
 * calls `mock_warehouse_advance`. That split is the point of the fixture:
 * the hub's whole design rests on the outcome arriving as an EVENT some time
 * after the ack, and an adapter that did the work inline would let the hub
 * pass a test it would fail against a real 3PL.
 *
 * Every op here is a pure function of the store plus the fixtures, so the
 * conformance harness drives this exact map with no platform behind it.
 */

import { depsFor, type WarehouseDeps } from '../lib/deps';
import { report, safeEmit, type EmitOutcome, type MockWarehouseEnv } from '../lib/env';
import {
  DEFAULT_SCAN_STAGE,
  DELIVERY_SEQUENCE,
  eventRefFor,
  isShipmentStage,
  parseScans,
  scanStamp,
  shipmentRefFor,
  SHIPMENT_STAGES,
  STAGE_LOCATION,
  type ScanRecord,
  type ShipmentStage,
} from '../lib/scans';
import { STOCK_FIXTURE, WAREHOUSE_FIXTURE } from '../lib/stock';
import type { RequestRecord, RequestStage } from '../lib/store';

export const ADAPTER_SLUG = 'mock-warehouse';

type Ack = { status: 'accepted' | 'queued' | 'rejected'; provider_ref?: string; reason?: string };

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

export function describe() {
  return {
    adapter_slug: ADAPTER_SLUG,
    capabilities: {
      supports_cancel: true,
      supports_split: false,
      supports_hold: false,
      tracking_mode: 'push' as const,
      stock_mode: 'snapshot' as const,
      countries: ['AU', 'NZ'],
    },
  };
}

export function listWarehouses() {
  return { warehouses: WAREHOUSE_FIXTURE.map((w) => ({ ...w })) };
}

/**
 * Idempotent on `fulfilment_request_id`. Reads the record first and returns
 * the stored ref on a hit, so neither the vendor nor D1 is touched twice.
 * The hub's outbox is at-least-once; without this a redelivery ships the
 * order again.
 */
export async function pushOrder(deps: WarehouseDeps, args: PushOrderArgs): Promise<Ack> {
  if (!args?.fulfilment_request_id) {
    return { status: 'rejected', reason: 'fulfilment_request_id is required' };
  }
  if (!WAREHOUSE_FIXTURE.some((w) => w.warehouse_key === args.warehouse_key)) {
    return {
      status: 'rejected',
      reason: `unknown warehouse_key "${args.warehouse_key}" (known: ${WAREHOUSE_FIXTURE.map((w) => w.warehouse_key).join(', ')})`,
    };
  }

  const existing = await deps.store.get(args.fulfilment_request_id);
  if (existing) return { status: 'queued', provider_ref: existing.provider_ref };

  const created = await deps.vendor.createOrder({
    fulfilment_request_id: args.fulfilment_request_id,
    warehouse_key: args.warehouse_key,
    line_count: args.lines?.length ?? 0,
  });
  const now = deps.now();
  await deps.store.insert({
    fulfilment_request_id: args.fulfilment_request_id,
    provider_ref: created.provider_ref,
    order_id: args.order_id ?? '',
    warehouse_key: args.warehouse_key,
    lines_json: JSON.stringify(args.lines ?? []),
    stage: 'queued',
    carrier: '',
    tracking_number: '',
    scans_json: '[]',
    delivered_at: '',
    created_at: now,
    updated_at: now,
  });
  // `queued`, not `accepted`: the warehouse has not looked at it yet. The
  // hub learns it was accepted from provider.order.accepted, on advance.
  return { status: 'queued', provider_ref: created.provider_ref };
}

export async function cancelOrder(
  deps: WarehouseDeps,
  args: { fulfilment_request_id: string; provider_ref?: string; reason?: string },
): Promise<Ack> {
  const row = await deps.store.get(args?.fulfilment_request_id ?? '');
  if (!row) return { status: 'rejected', reason: `no request ${args?.fulfilment_request_id}` };
  if (row.stage === 'shipped' || row.stage === 'delivered') {
    return { status: 'rejected', reason: `already ${row.stage}` };
  }
  await deps.store.update(row.fulfilment_request_id, {
    stage: 'cancelled',
    carrier: row.carrier,
    tracking_number: row.tracking_number,
    updated_at: deps.now(),
  });
  // Acknowledged, not done: provider.order.cancelled follows on advance.
  return { status: 'accepted' };
}

const STAGE_TO_STATUS: Record<RequestStage, string> = {
  queued: 'pending',
  accepted: 'accepted',
  shipped: 'shipped',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

export async function getOrderStatus(
  deps: WarehouseDeps,
  args: { fulfilment_request_id: string; provider_ref?: string },
) {
  const row = await deps.store.get(args?.fulfilment_request_id ?? '');
  if (!row) return { status: 'unknown', provider_status_raw: 'NOT_FOUND' };
  const base = { status: STAGE_TO_STATUS[row.stage], provider_status_raw: row.stage.toUpperCase() };
  if (row.stage !== 'shipped' && row.stage !== 'delivered') return base;
  return {
    ...base,
    tracking: {
      carrier: row.carrier,
      tracking_number: row.tracking_number,
      tracking_url: `https://track.mock-warehouse.test/${row.tracking_number}`,
    },
  };
}

export function getStock(deps: WarehouseDeps, args: { warehouse_key?: string; skus?: string[] }) {
  const snapshotAt = deps.now();
  const wanted = Array.isArray(args?.skus) && args.skus.length > 0 ? new Set(args.skus) : null;
  const levels = STOCK_FIXTURE.filter(
    (row) =>
      (!args?.warehouse_key || row.warehouse_key === args.warehouse_key) && (!wanted || wanted.has(row.sku)),
  ).map((row) => ({
    provider_adapter: ADAPTER_SLUG,
    warehouse_key: row.warehouse_key,
    sku: row.sku,
    on_hand: row.on_hand,
    reserved: row.reserved,
    held: row.held,
    snapshot_at: snapshotAt,
  }));
  return { levels };
}

export function health() {
  return { ok: true, credentials_ok: true, breaker_open: false, detail: 'mock warehouse, always up' };
}

// ---------------------------------------------------------------------------
// The shakedown lever
// ---------------------------------------------------------------------------

export interface AdvanceArgs {
  fulfilment_request_id: string;
  /**
   * `accept` then `ship` are the normal path; `scan` and `deliver` drive the
   * carrier callbacks the hub learns transit and delivery from; `cancel`
   * closes a cancellation.
   */
  to?: 'accept' | 'ship' | 'scan' | 'deliver' | 'cancel';
  carrier?: string;
  tracking_number?: string;
  /** `to: 'scan'` only: which scan to emit. Defaults to `departed_warehouse`. */
  stage?: ShipmentStage;
  /** `to: 'scan'` only: overrides the stage's default location. */
  location?: string;
  /** `to: 'scan'` only: free text the carrier would put on the scan. */
  detail?: string;
}

export interface AdvanceResult {
  ok: boolean;
  stage?: RequestStage;
  provider_ref?: string;
  emitted?: EmitOutcome[];
  /** The scans THIS call emitted, in order. Absent on the non-scan levers. */
  scans?: ScanRecord[];
  /** ISO 8601 UTC, set by the `deliver` lever. */
  delivered_at?: string;
  reason?: string;
}

/**
 * Move one request forward and emit what a real warehouse's callback would.
 * `accept` fires provider.order.accepted; `ship` fires
 * provider.shipment.created; calling it with no `to` does both in order,
 * which is what a hub shakedown wants from one click.
 *
 * `scan` and `deliver` are the carrier half. A real 3PL reports transit
 * through provider.shipment.event, which is the ONLY way the hub learns a
 * parcel moved: without a lever for it the hub's carrier-scan handler, its
 * delivered_at and its transit KPIs are unreachable from a shakedown.
 */
export async function advance(
  env: MockWarehouseEnv,
  deps: WarehouseDeps,
  args: AdvanceArgs,
): Promise<AdvanceResult> {
  const row = await deps.store.get(args?.fulfilment_request_id ?? '');
  if (!row) return { ok: false, reason: `no request ${args?.fulfilment_request_id}` };

  const emitted: EmitOutcome[] = [];
  const to = args?.to;

  if (to === 'scan') return scanOnce(env, deps, row, args);
  if (to === 'deliver') return deliver(env, deps, row);

  if (to === 'cancel') {
    await setStage(deps, row, 'cancelled');
    emitted.push(
      await safeEmit(env, 'provider.order.cancelled', {
        adapter_slug: ADAPTER_SLUG,
        interface_version: '1.0.0',
        fulfilment_request_id: row.fulfilment_request_id,
        provider_ref: row.provider_ref,
      }),
    );
    await report(env, 'advance', { request: row.fulfilment_request_id, to: 'cancelled' });
    return { ok: true, stage: 'cancelled', provider_ref: row.provider_ref, emitted };
  }

  if (row.stage === 'queued' && to !== 'ship') {
    await setStage(deps, row, 'accepted');
    emitted.push(
      await safeEmit(env, 'provider.order.accepted', {
        adapter_slug: ADAPTER_SLUG,
        interface_version: '1.0.0',
        fulfilment_request_id: row.fulfilment_request_id,
        provider_ref: row.provider_ref,
        warehouse_key: row.warehouse_key,
      }),
    );
  }

  if (to === 'accept') {
    await report(env, 'advance', { request: row.fulfilment_request_id, to: 'accepted' });
    return { ok: true, stage: 'accepted', provider_ref: row.provider_ref, emitted };
  }

  const carrier = args?.carrier || 'Mock Carrier';
  const trackingNumber = args?.tracking_number || `MWTRK${row.fulfilment_request_id.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
  const shippedAt = deps.now();
  await deps.store.update(row.fulfilment_request_id, {
    stage: 'shipped',
    carrier,
    tracking_number: trackingNumber,
    updated_at: shippedAt,
  });
  emitted.push(
    await safeEmit(env, 'provider.shipment.created', {
      adapter_slug: ADAPTER_SLUG,
      interface_version: '1.0.0',
      fulfilment_request_id: row.fulfilment_request_id,
      provider_ref: row.provider_ref,
      shipment: {
        provider_shipment_ref: shipmentRefFor(row.fulfilment_request_id),
        carrier,
        tracking_number: trackingNumber,
        tracking_url: `https://track.mock-warehouse.test/${trackingNumber}`,
        lines: JSON.parse(row.lines_json) as unknown,
        weight_grams: 1200,
        dimensions: { length_mm: 300, width_mm: 200, height_mm: 100 },
        shipped_at: shippedAt,
      },
    }),
  );
  await report(env, 'advance', { request: row.fulfilment_request_id, to: 'shipped' });
  return { ok: true, stage: 'shipped', provider_ref: row.provider_ref, emitted };
}

/**
 * `to: 'scan'` - one carrier scan on the request's shipment.
 *
 * Refused before the request ships: a scan hangs off a shipment, and the hub
 * correlates it on `provider_shipment_ref`. Emitting one for a shipment that
 * was never created would be an event the hub cannot place, which is worse
 * than a refusal a shakedown can read.
 */
async function scanOnce(
  env: MockWarehouseEnv,
  deps: WarehouseDeps,
  row: RequestRecord,
  args: AdvanceArgs,
): Promise<AdvanceResult> {
  if (!hasShipped(row)) {
    return {
      ok: false,
      stage: row.stage,
      provider_ref: row.provider_ref,
      reason: `request ${row.fulfilment_request_id} has not shipped (stage ${row.stage}); advance to=ship first`,
    };
  }
  const requested = args?.stage ?? DEFAULT_SCAN_STAGE;
  if (!isShipmentStage(requested)) {
    return {
      ok: false,
      stage: row.stage,
      provider_ref: row.provider_ref,
      reason: `unknown stage "${String(requested)}" (known: ${SHIPMENT_STAGES.join(', ')})`,
    };
  }
  return emitScans(env, deps, row, [
    {
      stage: requested,
      occurred_at: scanStamp(deps.now()),
      location: args?.location || STAGE_LOCATION[requested],
      detail: args?.detail || undefined,
    },
  ]);
}

/**
 * `to: 'deliver'` - the four scans a real carrier reports between the
 * warehouse door and the doorstep, in order, then the delivery on the row.
 * One lever because a hub shakedown wants the whole transit-to-delivered arc
 * from one click, the same way a bare advance wants accept-then-ship.
 */
async function deliver(
  env: MockWarehouseEnv,
  deps: WarehouseDeps,
  row: RequestRecord,
): Promise<AdvanceResult> {
  if (!hasShipped(row)) {
    return {
      ok: false,
      stage: row.stage,
      provider_ref: row.provider_ref,
      reason: `request ${row.fulfilment_request_id} has not shipped (stage ${row.stage}); advance to=ship first`,
    };
  }
  const now = deps.now();
  const last = DELIVERY_SEQUENCE.length - 1;
  // Backdated by whole seconds so the four carry distinct, ORDERED stamps
  // and none of them is in the future: the delivered scan is now, the three
  // before it are the recent past a carrier would be reporting.
  const requested = DELIVERY_SEQUENCE.map((stage, i) => ({
    stage,
    occurred_at: scanStamp(now, i - last),
    location: STAGE_LOCATION[stage],
    detail: undefined,
  }));
  return emitScans(env, deps, row, requested);
}

function hasShipped(row: RequestRecord): boolean {
  return row.stage === 'shipped' || row.stage === 'delivered';
}

/**
 * Mint, emit and record a run of scans.
 *
 * Every scan in the run is emitted, then the row is rewritten ONCE with the
 * whole history and, if the run delivered, the delivery. One row per request
 * still: the scans are a JSON column, never a row per event.
 */
async function emitScans(
  env: MockWarehouseEnv,
  deps: WarehouseDeps,
  row: RequestRecord,
  requested: Array<{ stage: ShipmentStage; occurred_at: string; location?: string; detail?: string }>,
): Promise<AdvanceResult> {
  const history = parseScans(row.scans_json);
  const emitted: EmitOutcome[] = [];
  const minted: ScanRecord[] = [];
  const shipmentRef = shipmentRefFor(row.fulfilment_request_id);

  for (const { stage, occurred_at, location, detail } of requested) {
    // The ref counts scans of this stage already on the row PLUS the ones
    // minted earlier in this run, so a repeat of a stage is a new event
    // rather than a dedup collision at the hub.
    const scan: ScanRecord = {
      stage,
      occurred_at,
      provider_event_ref: eventRefFor(row.fulfilment_request_id, stage, [...history, ...minted]),
      ...(location ? { location } : {}),
      ...(detail ? { detail } : {}),
    };
    minted.push(scan);
    emitted.push(
      await safeEmit(env, 'provider.shipment.event', {
        adapter_slug: ADAPTER_SLUG,
        interface_version: '1.0.0',
        fulfilment_request_id: row.fulfilment_request_id,
        provider_ref: row.provider_ref,
        provider_shipment_ref: shipmentRef,
        tracking_number: row.tracking_number,
        stage: scan.stage,
        occurred_at: scan.occurred_at,
        provider_event_ref: scan.provider_event_ref,
        ...(scan.location ? { location: scan.location } : {}),
        ...(scan.detail ? { detail: scan.detail } : {}),
      }),
    );
  }

  const deliveredScan = [...minted].reverse().find((scan) => scan.stage === 'delivered');
  const deliveredAt = deliveredScan?.occurred_at ?? row.delivered_at;
  const stage: RequestStage = deliveredScan ? 'delivered' : row.stage;
  await deps.store.update(row.fulfilment_request_id, {
    stage,
    carrier: row.carrier,
    tracking_number: row.tracking_number,
    scans_json: JSON.stringify([...history, ...minted]),
    ...(deliveredScan ? { delivered_at: deliveredAt } : {}),
    updated_at: deps.now(),
  });
  await report(env, 'advance', {
    request: row.fulfilment_request_id,
    to: deliveredScan ? 'delivered' : 'scanned',
    stages: minted.map((scan) => scan.stage),
  });
  return {
    ok: true,
    stage,
    provider_ref: row.provider_ref,
    emitted,
    scans: minted,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
  };
}

async function setStage(deps: WarehouseDeps, row: RequestRecord, stage: RequestStage): Promise<void> {
  await deps.store.update(row.fulfilment_request_id, {
    stage,
    carrier: row.carrier,
    tracking_number: row.tracking_number,
    updated_at: deps.now(),
  });
}

// ---------------------------------------------------------------------------
// The handler map the marketplace runtime dispatches, and the conformance
// harness drives. Tool names are `<slug_with_underscores>_<op>`, which is the
// only spelling publish accepts for a provides-tagged tool.
// ---------------------------------------------------------------------------

export default {
  mock_warehouse_describe: () => describe(),
  mock_warehouse_list_warehouses: () => listWarehouses(),
  mock_warehouse_push_order: (args: PushOrderArgs, env: MockWarehouseEnv) => pushOrder(depsFor(env), args),
  mock_warehouse_cancel_order: (
    args: { fulfilment_request_id: string; provider_ref?: string; reason?: string },
    env: MockWarehouseEnv,
  ) => cancelOrder(depsFor(env), args),
  mock_warehouse_get_order_status: (
    args: { fulfilment_request_id: string; provider_ref?: string },
    env: MockWarehouseEnv,
  ) => getOrderStatus(depsFor(env), args),
  mock_warehouse_get_stock: (args: { warehouse_key?: string; skus?: string[] }, env: MockWarehouseEnv) =>
    getStock(depsFor(env), args),
  mock_warehouse_health: () => health(),
  mock_warehouse_advance: (args: AdvanceArgs, env: MockWarehouseEnv) => advance(env, depsFor(env), args),
};
