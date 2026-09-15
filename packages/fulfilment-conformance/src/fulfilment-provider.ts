/**
 * Conformance suite for `fulfilment-hub/fulfilment_provider` v1.0.0.
 *
 * Drives all seven ops in contract order against the adapter's handler map,
 * chaining the ids the ops produce (the warehouse key from
 * `list_warehouses`, the `provider_ref` from `push_order`) so the run is one
 * coherent sequence rather than seven isolated pokes.
 *
 * The behavioural check the whole hub rests on is `push_order` idempotency:
 * the outbox retries, the platform delivers at least once, and a second
 * push that reaches the warehouse ships the order twice.
 */

import { FULFILMENT_PROVIDER_OPS } from './contract';
import { driveOp, opByName, type DriveContext } from './drive';
import { CheckCollector, type ConformanceReport } from './report';
import { isPlainObject } from './shape';
import type { AdapterHandlers, ConformanceOptions } from './types';

const DEFAULT_BUDGET_MS = 20_000;

const SHIP_TO = {
  name: 'Conformance Buyer',
  line1: '1 Test Street',
  line2: '',
  city: 'Brisbane',
  region: 'QLD',
  postcode: '4000',
  country: 'AU',
  phone: '+61700000000',
  email: 'buyer@example.test',
};

function pushArgs(
  fulfilmentRequestId: string,
  orderId: string,
  warehouseKey: string,
): Record<string, unknown> {
  return {
    fulfilment_request_id: fulfilmentRequestId,
    order_id: orderId,
    source_number: 'CONF-1001',
    warehouse_key: warehouseKey,
    ship_to: SHIP_TO,
    customer_email: 'buyer@example.test',
    lines: [
      {
        line_id: 'ln_conf_1',
        sku: 'CONF-SKU-1',
        title: 'Conformance widget',
        quantity: 2,
        unit_price_minor: 1250,
        currency: 'AUD',
      },
    ],
    currency: 'AUD',
    total_minor: 2500,
    notes: 'fulfilment-hub conformance harness',
  };
}

export async function runFulfilmentProviderConformance(
  handlers: AdapterHandlers,
  opts: ConformanceOptions,
): Promise<ConformanceReport> {
  const checks = new CheckCollector();
  const ctx: DriveContext = {
    handlers,
    env: opts.env(),
    slug: opts.slug,
    budgetMs: opts.timeBudgetMs ?? DEFAULT_BUDGET_MS,
    fixtures: opts.fixtures ?? {},
    checks,
  };
  const op = (name: string) => opByName(FULFILMENT_PROVIDER_OPS, name);

  // 1. describe -- the hub reads capabilities here and never from error text.
  const described = await driveOp(ctx, op('describe'), {});
  if (described) {
    checks.add(
      'describe.adapter_slug_matches',
      described.adapter_slug === opts.slug,
      described.adapter_slug === opts.slug
        ? `describe reports adapter_slug=${opts.slug}`
        : `describe reports adapter_slug=${JSON.stringify(described.adapter_slug)} but the install is ${opts.slug}; the hub attributes rows by this value`,
    );
  }
  const caps = isPlainObject(described?.capabilities) ? described!.capabilities : {};

  // 2. list_warehouses -- the key push_order routes to.
  const warehouses = await driveOp(ctx, op('list_warehouses'), {});
  const firstWarehouse = Array.isArray(warehouses?.warehouses) ? warehouses!.warehouses[0] : undefined;
  const warehouseKey =
    isPlainObject(firstWarehouse) && typeof firstWarehouse.warehouse_key === 'string'
      ? firstWarehouse.warehouse_key
      : 'wh_conformance';
  checks.add(
    'list_warehouses.non_empty',
    isPlainObject(firstWarehouse),
    isPlainObject(firstWarehouse)
      ? `first warehouse is ${warehouseKey}`
      : 'list_warehouses returned no warehouses, so the hub has nothing to route to and push_order below runs against a made-up key',
  );

  // 3. push_order, then the same id again: the idempotency contract.
  const vendorCalls = opts.vendorCalls;
  if (!vendorCalls) {
    checks.fail(
      'push_order.vendor_call_counted',
      'opts.vendorCalls() was not supplied, so the harness cannot prove a repeat push_order was served from the idempotency record rather than the warehouse. Wire a call-counting fake vendor into the fake env and pass its reader.',
    );
  }

  const firstId = 'fr_conformance_a';
  const before = vendorCalls ? vendorCalls() : 0;
  const first = await driveOp(ctx, op('push_order'), pushArgs(firstId, 'ord_conformance_a', warehouseKey));
  const afterFirst = vendorCalls ? vendorCalls() : 0;

  const repeat = await driveOp(ctx, op('push_order'), pushArgs(firstId, 'ord_conformance_a', warehouseKey));
  const afterRepeat = vendorCalls ? vendorCalls() : 0;

  const firstRef = typeof first?.provider_ref === 'string' ? first.provider_ref : undefined;
  const repeatRef = typeof repeat?.provider_ref === 'string' ? repeat.provider_ref : undefined;
  checks.add(
    'push_order.idempotent_provider_ref',
    firstRef !== undefined && firstRef === repeatRef,
    firstRef !== undefined && firstRef === repeatRef
      ? `a repeat push of ${firstId} returned the same provider_ref (${firstRef})`
      : `a repeat push of ${firstId} must return the same provider_ref; first=${JSON.stringify(firstRef)} repeat=${JSON.stringify(repeatRef)}`,
  );
  checks.add(
    'push_order.idempotent_status',
    first?.status !== undefined && first?.status === repeat?.status,
    first?.status === repeat?.status
      ? `a repeat push returned the same status (${String(first?.status)})`
      : `a repeat push must return the same ack; first=${JSON.stringify(first?.status)} repeat=${JSON.stringify(repeat?.status)}`,
  );
  if (vendorCalls) {
    const repeatCost = afterRepeat - afterFirst;
    checks.add(
      'push_order.repeat_does_not_reach_vendor',
      repeatCost === 0,
      repeatCost === 0
        ? 'the repeat push made no vendor call'
        : `the repeat push made ${repeatCost} vendor call(s). The hub's outbox is at-least-once, so a second delivery of the same fulfilment_request_id would ship the order twice.`,
    );
    // Mutation-honesty: without this, an adapter that never calls its vendor
    // at all would pass the check above for the wrong reason.
    const firstCost = afterFirst - before;
    checks.add(
      'push_order.first_push_reaches_vendor',
      firstCost > 0,
      firstCost > 0
        ? `the first push made ${firstCost} vendor call(s)`
        : 'the first push made no vendor call, so the idempotency check above proves nothing. Count the call the adapter makes to its warehouse API in the fake vendor.',
    );
  }

  // A DISTINCT request must be pushed on its own, not folded into the first.
  const secondId = 'fr_conformance_b';
  const beforeSecond = vendorCalls ? vendorCalls() : 0;
  const second = await driveOp(ctx, op('push_order'), pushArgs(secondId, 'ord_conformance_b', warehouseKey));
  const afterSecond = vendorCalls ? vendorCalls() : 0;
  const secondRef = typeof second?.provider_ref === 'string' ? second.provider_ref : undefined;
  checks.add(
    'push_order.distinct_request_distinct_ref',
    secondRef !== undefined && secondRef !== firstRef,
    secondRef !== undefined && secondRef !== firstRef
      ? `${secondId} got its own provider_ref (${secondRef})`
      : `a different fulfilment_request_id must get its own provider_ref; ${firstId}=${JSON.stringify(firstRef)} ${secondId}=${JSON.stringify(secondRef)}`,
  );
  if (vendorCalls) {
    const cost = afterSecond - beforeSecond;
    checks.add(
      'push_order.distinct_request_reaches_vendor',
      cost > 0,
      cost > 0
        ? `${secondId} made ${cost} vendor call(s)`
        : `${secondId} made no vendor call: the idempotency record is keyed on something coarser than fulfilment_request_id`,
    );
  }

  // 4. get_order_status on the request the harness just pushed.
  await driveOp(ctx, op('get_order_status'), {
    fulfilment_request_id: firstId,
    provider_ref: firstRef ?? 'unknown',
  });

  // 5. cancel_order. An adapter whose capabilities say supports_cancel:false
  //    still has to answer with an ack (`rejected` + reason), never a throw.
  const cancelled = await driveOp(ctx, op('cancel_order'), {
    fulfilment_request_id: secondId,
    provider_ref: secondRef ?? 'unknown',
    reason: 'conformance harness cancel',
  });
  if (cancelled && caps.supports_cancel === false) {
    checks.add(
      'cancel_order.matches_capability',
      cancelled.status === 'rejected',
      cancelled.status === 'rejected'
        ? 'capabilities say supports_cancel:false and cancel_order refuses cleanly'
        : `capabilities say supports_cancel:false but cancel_order answered "${String(cancelled.status)}"; the hub chooses its path from capabilities and would wait for an event that never arrives`,
    );
  }

  // 6. get_stock + health.
  await driveOp(ctx, op('get_stock'), { warehouse_key: warehouseKey, skus: ['CONF-SKU-1'] });
  await driveOp(ctx, op('health'), {});

  return checks.report();
}
