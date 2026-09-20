/**
 * fulfilment-hub v1, transcribed from docs/interfaces/fulfilment-hub-v1.md.
 *
 * This module is the single machine-readable copy of the contract inside the
 * kit: the op lists, their effects, their output shapes, the event names and
 * the closed enums. The harness, the manifest check and the scaffold
 * templates all read from here, so a contract change lands in one place and
 * every consumer of it moves together.
 *
 * The hub app's manifest in sprigr-apps carries the authoritative
 * `interfaces[]` definitions. When the two disagree, the manifest wins and
 * this file is fixed.
 */

import type { ObjectSpec } from './shape';

export const INTERFACE_VERSION = '1.0.0';

export type AdapterRole = 'order_source' | 'fulfilment_provider';

export const INTERFACE_IDS: Record<AdapterRole, string> = {
  order_source: 'fulfilment-hub/order_source',
  fulfilment_provider: 'fulfilment-hub/fulfilment_provider',
};

/**
 * The statuses a write op may return. Every op that reaches a third party is
 * asynchronous: it acknowledges inside the dispatch budget and the outcome
 * arrives as an event.
 *
 * The two interfaces do NOT share one enum (section 7, clarification 2). A
 * provider says `queued` when it has taken the request but not yet sent it,
 * and signals transient trouble later through
 * `provider.order.error { retryable: true }`. An order source has no such
 * event, so it says `error` inline for a transient failure the hub may
 * retry, against `rejected` for a terminal one. An adapter that returns the
 * other interface's spelling fails the harness, because the hub reads the
 * value to decide whether to retry.
 */
export const FULFILMENT_PROVIDER_ACK_STATUSES = ['accepted', 'queued', 'rejected'] as const;
export const ORDER_SOURCE_ACK_STATUSES = ['accepted', 'rejected', 'error'] as const;
export type FulfilmentProviderAckStatus = (typeof FULFILMENT_PROVIDER_ACK_STATUSES)[number];
export type OrderSourceAckStatus = (typeof ORDER_SOURCE_ACK_STATUSES)[number];
export type AckStatus = FulfilmentProviderAckStatus | OrderSourceAckStatus;

/** The statuses that must carry a non-empty `reason` (clarification 6). */
export const ACK_STATUSES_NEEDING_REASON = ['rejected', 'error'] as const;

/** `shipment_event.stage` is a closed enum; an adapter maps its carrier onto it. */
export const SHIPMENT_STAGES = [
  'label_printed',
  'departed_warehouse',
  'first_scan',
  'destination_arrival',
  'delivered',
  'exception',
] as const;

export const ORDER_STATUSES = [
  'received',
  'routing',
  'pushed',
  'accepted',
  'shipped',
  'delivered',
  'cancelled',
  'failed',
  'held',
] as const;

export const FULFILMENT_REQUEST_STATUSES = [
  'pending',
  'pushed',
  'accepted',
  'rejected',
  'error',
  'shipped',
  'cancelled',
  'cancel_refused',
] as const;

export const EXCEPTION_KINDS = [
  'short_pick',
  'address_invalid',
  'prohibited_item',
  'provider_error',
  'routing_timeout',
  'unknown',
] as const;

export const EXCEPTION_SEVERITIES = ['info', 'warning', 'critical'] as const;

// ---------------------------------------------------------------------------
// Canonical records (contract section 2). Adapters SEND these; the hub stores
// them. Every field is required: an adapter that omits one is not
// interchangeable with one that fills it, which is the whole point of the
// interface. Empty strings are allowed where the contract says a value may be
// absent (`hold_reason` when not held, `order_id` before the hub assigns it).
// ---------------------------------------------------------------------------

export const ADDRESS_SPEC: ObjectSpec = {
  required: { line1: 'nonempty_string', city: 'string', country: 'country_code' },
  optional: {
    name: 'string',
    company: 'string',
    line2: 'string',
    region: 'string',
    postcode: 'string',
    phone: 'string',
    email: 'string',
  },
};

export const ORDER_SPEC: ObjectSpec = {
  required: {
    order_id: 'string',
    source_adapter: 'nonempty_string',
    source_ref: 'nonempty_string',
    source_number: 'string',
    channel: 'nonempty_string',
    status: { enum: ORDER_STATUSES },
    placed_at: 'iso_utc',
    currency: 'currency_code',
    total_minor: 'integer',
    customer_email: 'string',
    ship_to_json: 'string',
    tags_json: 'string',
    hold_reason: 'string',
    updated_at: 'iso_utc',
  },
};

export const ORDER_LINE_SPEC: ObjectSpec = {
  required: {
    order_id: 'string',
    line_id: 'nonempty_string',
    source_line_ref: 'nonempty_string',
    sku: 'nonempty_string',
    title: 'string',
    quantity: 'integer',
    unit_price_minor: 'integer',
    currency: 'currency_code',
    requires_shipping: 'boolean',
  },
};

export const STOCK_LEVEL_SPEC: ObjectSpec = {
  required: {
    provider_adapter: 'nonempty_string',
    warehouse_key: 'nonempty_string',
    sku: 'nonempty_string',
    on_hand: 'integer',
    reserved: 'integer',
    held: 'integer',
    snapshot_at: 'iso_utc',
  },
};

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export interface OpSpec {
  readonly name: string;
  readonly effects: 'read' | 'write';
  /** Structural spec for the op's output object. */
  readonly output: ObjectSpec;
  /**
   * True when the output is an async ack. The harness additionally requires
   * a `reason` on `rejected` (and on an order source's `error`), because an
   * unexplained refusal is indistinguishable from a bug at the hub.
   */
  readonly ack: boolean;
  /** The exact status set this op's interface allows. Empty for a read op. */
  readonly ackStatuses: readonly string[];
  /** Output field that must be a non-empty string when the ack is not `rejected`. */
  readonly ackRefField?: string;
}

const PROVIDER_ACK = { status: { enum: FULFILMENT_PROVIDER_ACK_STATUSES } } as const;
const SOURCE_ACK = { status: { enum: ORDER_SOURCE_ACK_STATUSES } } as const;

export const ORDER_SOURCE_CAPABILITIES_SPEC: ObjectSpec = {
  required: {
    supports_hold: 'boolean',
    supports_split: 'boolean',
    supports_cancel: 'boolean',
    supports_stock_write: 'boolean',
    request_model: { enum: ['fulfilment_orders', 'orders'] },
  },
  optional: {
    /**
     * 1.4.0. The source accepts `update_address`, so an operator can correct
     * a ship-to in the hub and have the selling system corrected with it.
     * OPTIONAL on the spec, and absent reads as false, because every adapter
     * written against 1.3.0 predates the op: a hub that treated absence as
     * unsupported-but-required would fail conformance for every one of them.
     */
    supports_address_update: 'boolean',
  },
};

export const FULFILMENT_PROVIDER_CAPABILITIES_SPEC: ObjectSpec = {
  required: {
    supports_cancel: 'boolean',
    supports_split: 'boolean',
    supports_hold: 'boolean',
    tracking_mode: { enum: ['push', 'poll', 'scrape'] },
    stock_mode: { enum: ['snapshot', 'delta', 'none'] },
    countries: 'string_array',
  },
};

export const ORDER_SOURCE_OPS: readonly OpSpec[] = [
  {
    name: 'describe',
    effects: 'read',
    ack: false,
    ackStatuses: [],
    output: {
      required: {
        adapter_slug: 'nonempty_string',
        channel: 'nonempty_string',
        capabilities: { object: ORDER_SOURCE_CAPABILITIES_SPEC },
      },
    },
  },
  {
    name: 'list_locations',
    effects: 'read',
    ack: false,
    ackStatuses: [],
    output: {
      required: {
        locations: {
          array_of: {
            required: {
              source_location_ref: 'nonempty_string',
              name: 'string',
              country: 'country_code',
              active: 'boolean',
            },
          },
        },
      },
    },
  },
  {
    name: 'register_location',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { source_location_ref: 'string', reason: 'string' } },
  },
  {
    name: 'get_order',
    effects: 'read',
    ack: false,
    ackStatuses: [],
    output: {
      required: { found: 'boolean' },
      optional: { order: { object: ORDER_SPEC }, lines: { array_of: ORDER_LINE_SPEC } },
    },
  },
  {
    name: 'accept_request',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { reason: 'string' } },
  },
  {
    name: 'reject_request',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { reason: 'string' } },
  },
  {
    name: 'mark_shipped',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { source_fulfilment_ref: 'string', reason: 'string' } },
  },
  {
    name: 'hold',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { reason: 'string' } },
  },
  {
    name: 'release',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { reason: 'string' } },
  },
  {
    name: 'cancel',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { reason: 'string' } },
  },
  {
    name: 'split',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { new_source_request_ref: 'string', reason: 'string' } },
  },
  {
    name: 'set_stock_level',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { reason: 'string' } },
  },
  {
    name: 'add_note',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { reason: 'string' } },
  },
  {
    /**
     * 1.4.0. Correct an order's ship-to in the selling system.
     *
     * `{ source_ref, ship_to: address, reason? }`. A PARTIAL update: only the
     * address fields the caller supplies change, so a hub correcting one
     * mistyped street number does not have to re-send (and risk clobbering) a
     * name and postcode it never touched.
     *
     * The op is about the SHIPPING address only. `address.email` is carried
     * for the warehouse's benefit and is not a shipping-address field in any
     * selling system we target, so a source is free to ignore it; the hub
     * keeps the customer email on its own record either way.
     *
     * A source that cannot do this at all answers
     * `{ status: 'rejected', reason: 'unsupported' }` and reports
     * `supports_address_update: false` (or omits it) from `describe`. A
     * source that CAN, but not for this order any more (already dispatched,
     * already invoiced), answers `rejected` with its own reason: that is a
     * refusal of this order, not of the op, and the hub surfaces the text.
     */
    name: 'update_address',
    effects: 'write',
    ack: true,
    ackStatuses: ORDER_SOURCE_ACK_STATUSES,
    output: { required: SOURCE_ACK, optional: { reason: 'string' } },
  },
];

export const FULFILMENT_PROVIDER_OPS: readonly OpSpec[] = [
  {
    name: 'describe',
    effects: 'read',
    ack: false,
    ackStatuses: [],
    output: {
      required: {
        adapter_slug: 'nonempty_string',
        capabilities: { object: FULFILMENT_PROVIDER_CAPABILITIES_SPEC },
      },
    },
  },
  {
    name: 'list_warehouses',
    effects: 'read',
    ack: false,
    ackStatuses: [],
    output: {
      required: {
        warehouses: {
          array_of: {
            required: {
              warehouse_key: 'nonempty_string',
              name: 'string',
              country: 'country_code',
              active: 'boolean',
            },
            optional: { cutoff_local_time: 'string' },
          },
        },
      },
    },
  },
  {
    name: 'push_order',
    effects: 'write',
    ack: true,
    ackStatuses: FULFILMENT_PROVIDER_ACK_STATUSES,
    ackRefField: 'provider_ref',
    output: { required: PROVIDER_ACK, optional: { provider_ref: 'nonempty_string', reason: 'string' } },
  },
  {
    name: 'cancel_order',
    effects: 'write',
    ack: true,
    ackStatuses: FULFILMENT_PROVIDER_ACK_STATUSES,
    output: { required: PROVIDER_ACK, optional: { reason: 'string' } },
  },
  {
    name: 'get_order_status',
    effects: 'read',
    ack: false,
    ackStatuses: [],
    output: {
      required: { status: 'nonempty_string' },
      optional: {
        provider_status_raw: 'string',
        tracking: {
          object: {
            required: {
              carrier: 'nonempty_string',
              tracking_number: 'nonempty_string',
              tracking_url: 'string',
            },
          },
        },
      },
    },
  },
  {
    name: 'get_stock',
    effects: 'read',
    ack: false,
    ackStatuses: [],
    output: { required: { levels: { array_of: STOCK_LEVEL_SPEC } } },
  },
  {
    name: 'health',
    effects: 'read',
    ack: false,
    ackStatuses: [],
    output: {
      required: { ok: 'boolean', credentials_ok: 'boolean', breaker_open: 'boolean' },
      optional: { last_callback_at: 'iso_utc', detail: 'string' },
    },
  },
];

export const OPS_BY_ROLE: Record<AdapterRole, readonly OpSpec[]> = {
  order_source: ORDER_SOURCE_OPS,
  fulfilment_provider: FULFILMENT_PROVIDER_OPS,
};

export function opNames(role: AdapterRole): string[] {
  return OPS_BY_ROLE[role].map((o) => o.name);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * `source.*`, not `order_source.*` (section 7, clarification 1). The
 * platform's publish-time EVENT_NAME_REGEX allows no underscore in the first
 * dotted segment, and `sprigr app validate` does not run that check, so the
 * wrong spelling passes validate and is refused at publish.
 */
export const ORDER_SOURCE_EVENTS = [
  'source.order.created',
  'source.order.updated',
  'source.order.cancelled',
  'source.request.submitted',
  'source.request.cancellation_submitted',
  'source.request.hold_released',
  'source.stock.changed',
] as const;

export const FULFILMENT_PROVIDER_EVENTS = [
  'provider.order.accepted',
  'provider.order.rejected',
  'provider.order.error',
  'provider.order.cancelled',
  'provider.order.cancel_refused',
  'provider.shipment.created',
  'provider.shipment.event',
  'provider.stock.snapshot',
  'provider.exception.raised',
  'provider.exception.cleared',
] as const;

export const EVENTS_BY_ROLE: Record<AdapterRole, readonly string[]> = {
  order_source: ORDER_SOURCE_EVENTS,
  fulfilment_provider: FULFILMENT_PROVIDER_EVENTS,
};

/** The event-name prefix that belongs to each role, for the typo guard. */
export const EVENT_PREFIX_BY_ROLE: Record<AdapterRole, string> = {
  order_source: 'source.',
  fulfilment_provider: 'provider.',
};

/**
 * The events an adapter MUST declare in `events.emits[]`, given the ops it
 * claims. Every write op acknowledges asynchronously, so the hub only ever
 * learns the outcome from an event: an adapter that claims `push_order`
 * without declaring where `accepted` / `rejected` / `error` arrive has left
 * the hub with no way to close the request. An order source's two entries
 * are unconditional: `request.submitted` is THE routing trigger and
 * `order.created` is what gives the hub an order to route.
 */
export const REQUIRED_EMITS_BY_OP: Record<AdapterRole, Record<string, readonly string[]>> = {
  order_source: {
    '*': ['source.order.created', 'source.request.submitted'],
  },
  fulfilment_provider: {
    push_order: ['provider.order.accepted', 'provider.order.rejected', 'provider.order.error'],
    cancel_order: ['provider.order.cancelled', 'provider.order.cancel_refused'],
  },
};

/** `<adapter_slug_with_underscores>_<op>`, the only tool name publish accepts. */
export function toolNameFor(slug: string, op: string): string {
  return `${slug.replace(/-/g, '_')}_${op}`;
}
