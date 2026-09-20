/**
 * Conformance suite for `fulfilment-hub/order_source` v1.0.0.
 *
 * Drives all thirteen ops in contract order, chaining what the adapter
 * returns: the location ref from `list_locations` feeds `set_stock_level`,
 * and the order `get_order` resolves feeds the line refs `split` and
 * `mark_shipped` need.
 *
 * The suite checks SHAPE, BUDGET and the ack enum, not business outcome. A
 * stateful adapter that refuses an op is still conforming, as long as it
 * refuses with `rejected` plus a reason instead of throwing or inventing a
 * status of its own. Pass `opts.fixtures` with ids the adapter's own store
 * knows so the found paths are exercised rather than the miss paths.
 */

import { ORDER_SOURCE_OPS } from './contract';
import { driveOp, opByName, type DriveContext } from './drive';
import { CheckCollector, type ConformanceReport } from './report';
import { isPlainObject } from './shape';
import type { AdapterHandlers, ConformanceOptions } from './types';

const DEFAULT_BUDGET_MS = 20_000;

/** Fixture ids the harness uses when the caller supplies none. */
export const ORDER_SOURCE_FIXTURE_IDS = {
  source_ref: 'src_conformance_order',
  source_request_ref: 'srr_conformance_1',
  source_line_ref: 'sl_conformance_1',
  source_location_ref: 'loc_conformance_1',
} as const;

export async function runOrderSourceConformance(
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
  const op = (name: string) => opByName(ORDER_SOURCE_OPS, name);

  // 1. describe.
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

  // 2. list_locations -- what register_location and set_stock_level key off.
  const locations = await driveOp(ctx, op('list_locations'), {});
  const firstLocation = Array.isArray(locations?.locations) ? locations!.locations[0] : undefined;
  const locationRef =
    isPlainObject(firstLocation) && typeof firstLocation.source_location_ref === 'string'
      ? firstLocation.source_location_ref
      : ORDER_SOURCE_FIXTURE_IDS.source_location_ref;
  checks.add(
    'list_locations.non_empty',
    isPlainObject(firstLocation),
    isPlainObject(firstLocation)
      ? `first location is ${locationRef}`
      : 'list_locations returned no locations, so the hub cannot map a provider warehouse onto a source location',
  );

  // 3. register_location.
  await driveOp(ctx, op('register_location'), {
    warehouse_key: 'wh_conformance',
    name: 'Conformance Warehouse',
    country: 'AU',
    address: { line1: '1 Test Street', city: 'Brisbane', country: 'AU' },
  });

  // 4. get_order -- the only op that returns canonical records, so the one
  //    place the harness can check the order / order_line field types.
  const order = await driveOp(ctx, op('get_order'), {
    source_ref: ORDER_SOURCE_FIXTURE_IDS.source_ref,
  });
  const found = order?.found === true;
  checks.add(
    'get_order.resolves_the_fixture',
    found,
    found
      ? 'get_order resolved the fixture order, so its canonical shape was checked above'
      : `get_order answered found:false, so the order / order_line shapes were never exercised. Pass opts.fixtures.get_order = { source_ref: '<an id this adapter knows>' }.`,
  );
  const lines = Array.isArray(order?.lines) ? order!.lines : [];
  const firstLine = lines[0];
  const lineRef =
    isPlainObject(firstLine) && typeof firstLine.source_line_ref === 'string'
      ? firstLine.source_line_ref
      : ORDER_SOURCE_FIXTURE_IDS.source_line_ref;
  if (found) {
    checks.add(
      'get_order.returns_lines',
      lines.length > 0,
      lines.length > 0
        ? `${lines.length} line(s) returned`
        : 'get_order found the order but returned no lines; the hub routes lines, not orders',
    );
  }

  const requestRef = ORDER_SOURCE_FIXTURE_IDS.source_request_ref;
  const sourceRef = ORDER_SOURCE_FIXTURE_IDS.source_ref;

  // 5. the request lifecycle ops. Each is driven independently: the harness
  //    asserts the ack contract, not that the adapter's own state machine
  //    allows this particular sequence.
  await driveOp(ctx, op('accept_request'), { source_request_ref: requestRef });
  await driveOp(ctx, op('hold'), { source_request_ref: requestRef, reason: 'conformance hold' });
  await driveOp(ctx, op('release'), { source_request_ref: requestRef });

  const split = await driveOp(ctx, op('split'), {
    source_request_ref: requestRef,
    lines: [{ source_line_ref: lineRef, quantity: 1 }],
  });
  if (split && caps.supports_split === false) {
    checks.add(
      'split.matches_capability',
      split.status === 'rejected',
      split.status === 'rejected'
        ? 'capabilities say supports_split:false and split refuses cleanly'
        : `capabilities say supports_split:false but split answered "${String(split.status)}"; the hub picks its backorder path from capabilities`,
    );
  }

  await driveOp(ctx, op('mark_shipped'), {
    source_request_ref: requestRef,
    source_ref: sourceRef,
    carrier: 'Conformance Post',
    tracking_number: 'CONF123456789',
    tracking_url: 'https://track.example.test/CONF123456789',
    lines: [{ source_line_ref: lineRef, quantity: 1 }],
    notify_customer: false,
  });

  await driveOp(ctx, op('reject_request'), {
    source_request_ref: requestRef,
    reason: 'conformance reject',
  });

  const cancelled = await driveOp(ctx, op('cancel'), {
    source_request_ref: requestRef,
    reason: 'conformance cancel',
  });
  if (cancelled && caps.supports_cancel === false) {
    checks.add(
      'cancel.matches_capability',
      cancelled.status === 'rejected',
      cancelled.status === 'rejected'
        ? 'capabilities say supports_cancel:false and cancel refuses cleanly'
        : `capabilities say supports_cancel:false but cancel answered "${String(cancelled.status)}"`,
    );
  }

  // 6. stock write-back + the note the hub leaves on an exception.
  const stock = await driveOp(ctx, op('set_stock_level'), {
    source_location_ref: locationRef,
    sku: 'CONF-SKU-1',
    on_hand: 7,
  });
  if (stock && caps.supports_stock_write === false) {
    checks.add(
      'set_stock_level.matches_capability',
      stock.status === 'rejected',
      stock.status === 'rejected'
        ? 'capabilities say supports_stock_write:false and set_stock_level refuses cleanly'
        : `capabilities say supports_stock_write:false but set_stock_level answered "${String(stock.status)}"; the hub would stop reconciling stock it believes is being written`,
    );
  }

  await driveOp(ctx, op('add_note'), {
    source_ref: sourceRef,
    note: 'fulfilment hub conformance note',
    tags: ['fulfilment-hub'],
  });

  // 7. the ship-to correction (1.4.0). Driven against the fixture order, and
  // the capability check is the point: an adapter that says it supports the
  // op must not answer `rejected: unsupported`, and one that does not claim
  // it must refuse CLEANLY rather than erroring, because the hub's operator
  // is standing in front of a form waiting for an answer either way.
  const addressed = await driveOp(ctx, op('update_address'), {
    source_ref: sourceRef,
    ship_to: { line1: '1 Conformance Way', city: 'Brisbane', country: 'AU', postcode: '4000' },
    reason: 'fulfilment hub conformance address correction',
  });
  if (addressed) {
    const claims = caps.supports_address_update === true;
    const unsupported =
      addressed.status === 'rejected' && String(addressed.reason ?? '').includes('unsupported');
    if (claims) {
      checks.add(
        'update_address.matches_capability',
        !unsupported,
        unsupported
          ? 'capabilities say supports_address_update:true but update_address answered "unsupported"'
          : 'capabilities say supports_address_update:true and update_address is implemented',
      );
    } else {
      checks.add(
        'update_address.refuses_cleanly',
        addressed.status === 'rejected',
        addressed.status === 'rejected'
          ? 'no supports_address_update and update_address refuses cleanly'
          : `no supports_address_update but update_address answered "${String(addressed.status)}"; the hub would offer an address edit that silently does nothing`,
      );
    }
  }

  return checks.report();
}
