/**
 * mock-order-source - the records this app keeps, and the seed fixture.
 *
 * Field names and types are the contract's canonical `order` / `order_line`
 * shapes (section 2) on purpose: an order source's job is to hand the hub
 * those exact shapes, and a store that keeps something else has to translate
 * on every read, which is where the field drift starts.
 */

export interface OrderRecord {
  source_ref: string;
  source_number: string;
  /** One of the contract's order statuses. */
  status: string;
  placed_at: string;
  currency: string;
  total_minor: number;
  customer_email: string;
  ship_to_json: string;
  tags_json: string;
  notes_json: string;
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

export interface RequestRecord {
  source_request_ref: string;
  source_ref: string;
  source_location_ref: string;
  /** submitted | accepted | rejected | held | shipped | cancelled | split */
  state: string;
  lines_json: string;
  reason: string;
  source_fulfilment_ref: string;
  updated_at: string;
}

export interface LocationRecord {
  source_location_ref: string;
  name: string;
  country: string;
  active: boolean;
}

export interface StockRecord {
  source_location_ref: string;
  sku: string;
  on_hand: number;
  updated_at: string;
}

const SEED_AT = '2026-09-01T00:00:00Z';

/**
 * One order, one line, one submitted request, two locations. Written by
 * migration 0001 into per-install D1 and mirrored by the in-memory store, so
 * a fresh install can answer `get_order` and the whole request lifecycle
 * before anyone has placed anything. `__tests__/seed.test.ts` holds the two
 * copies to the same values.
 */
export const SEED_LOCATIONS: readonly LocationRecord[] = [
  { source_location_ref: 'mos_loc_bne', name: 'Mock Source Brisbane', country: 'AU', active: true },
  { source_location_ref: 'mos_loc_syd', name: 'Mock Source Sydney', country: 'AU', active: true },
];

export const SEED_ORDER: OrderRecord = {
  source_ref: 'mos_seed_1',
  source_number: 'MOS-1001',
  status: 'received',
  placed_at: SEED_AT,
  currency: 'AUD',
  total_minor: 4500,
  customer_email: 'seed.buyer@example.test',
  ship_to_json: JSON.stringify({
    name: 'Seed Buyer',
    line1: '1 Seed Street',
    city: 'Brisbane',
    region: 'QLD',
    postcode: '4000',
    country: 'AU',
  }),
  tags_json: JSON.stringify(['seed']),
  notes_json: '[]',
  hold_reason: '',
  updated_at: SEED_AT,
};

export const SEED_LINES: readonly LineRecord[] = [
  {
    source_line_ref: 'mos_seed_1_l1',
    source_ref: 'mos_seed_1',
    line_id: 'mos_seed_1_l1',
    sku: 'CONF-SKU-1',
    title: 'Seed widget',
    quantity: 2,
    unit_price_minor: 1500,
    currency: 'AUD',
    requires_shipping: true,
  },
  {
    source_line_ref: 'mos_seed_1_l2',
    source_ref: 'mos_seed_1',
    line_id: 'mos_seed_1_l2',
    sku: 'CONF-SKU-2',
    title: 'Seed gadget',
    quantity: 1,
    unit_price_minor: 1500,
    currency: 'AUD',
    requires_shipping: true,
  },
];

export const SEED_REQUEST: RequestRecord = {
  source_request_ref: 'mos_seed_1_r1',
  source_ref: 'mos_seed_1',
  source_location_ref: 'mos_loc_bne',
  state: 'submitted',
  lines_json: JSON.stringify([
    { source_line_ref: 'mos_seed_1_l1', sku: 'CONF-SKU-1', quantity: 2 },
    { source_line_ref: 'mos_seed_1_l2', sku: 'CONF-SKU-2', quantity: 1 },
  ]),
  reason: '',
  source_fulfilment_ref: '',
  updated_at: SEED_AT,
};
