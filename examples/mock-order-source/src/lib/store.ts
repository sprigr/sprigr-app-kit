/**
 * mock-order-source - the per-install store.
 *
 * Two implementations of one interface: the per-install D1 tables the
 * platform binds, and an in-memory map seeded with the same fixture. The
 * in-memory one is what lets the conformance harness drive the REAL handler
 * map with no D1 behind it.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';
import {
  SEED_LINES,
  SEED_LOCATIONS,
  SEED_ORDER,
  SEED_REQUEST,
  type LineRecord,
  type LocationRecord,
  type OrderRecord,
  type RequestRecord,
  type StockRecord,
} from './records';

export interface OrderSourceStore {
  getOrder(sourceRef: string): Promise<OrderRecord | null>;
  putOrder(order: OrderRecord): Promise<void>;
  listLines(sourceRef: string): Promise<LineRecord[]>;
  putLines(lines: readonly LineRecord[]): Promise<void>;
  getRequest(ref: string): Promise<RequestRecord | null>;
  putRequest(request: RequestRecord): Promise<void>;
  listLocations(): Promise<LocationRecord[]>;
  putLocation(location: LocationRecord): Promise<void>;
  putStock(level: StockRecord): Promise<void>;
  getStock(sourceLocationRef: string, sku: string): Promise<StockRecord | null>;
}

const boolIn = (v: boolean) => (v ? 1 : 0);
const boolOut = (v: unknown) => v === 1 || v === true;

export function d1Store(db: D1Like): OrderSourceStore {
  return {
    async getOrder(sourceRef) {
      const row = await db
        .prepare(
          `SELECT source_ref, source_number, status, placed_at, currency, total_minor,
                  customer_email, ship_to_json, tags_json, notes_json, hold_reason, updated_at
             FROM mock_order_source_orders WHERE source_ref = ?`,
        )
        .bind(sourceRef)
        .first<OrderRecord>();
      return row ?? null;
    },
    async putOrder(order) {
      await db
        .prepare(
          `INSERT INTO mock_order_source_orders
             (source_ref, source_number, status, placed_at, currency, total_minor,
              customer_email, ship_to_json, tags_json, notes_json, hold_reason, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_ref) DO UPDATE SET
             source_number = excluded.source_number, status = excluded.status,
             placed_at = excluded.placed_at, currency = excluded.currency,
             total_minor = excluded.total_minor, customer_email = excluded.customer_email,
             ship_to_json = excluded.ship_to_json, tags_json = excluded.tags_json,
             notes_json = excluded.notes_json, hold_reason = excluded.hold_reason,
             updated_at = excluded.updated_at`,
        )
        .bind(
          order.source_ref,
          order.source_number,
          order.status,
          order.placed_at,
          order.currency,
          order.total_minor,
          order.customer_email,
          order.ship_to_json,
          order.tags_json,
          order.notes_json,
          order.hold_reason,
          order.updated_at,
        )
        .run();
    },
    async listLines(sourceRef) {
      const res = await db
        .prepare(
          `SELECT source_line_ref, source_ref, line_id, sku, title, quantity,
                  unit_price_minor, currency, requires_shipping
             FROM mock_order_source_lines WHERE source_ref = ? ORDER BY source_line_ref`,
        )
        .bind(sourceRef)
        .all<LineRecord & { requires_shipping: unknown }>();
      return res.results.map((r) => ({ ...r, requires_shipping: boolOut(r.requires_shipping) }));
    },
    async putLines(lines) {
      for (const line of lines) {
        await db
          .prepare(
            `INSERT INTO mock_order_source_lines
               (source_line_ref, source_ref, line_id, sku, title, quantity,
                unit_price_minor, currency, requires_shipping)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_line_ref) DO NOTHING`,
          )
          .bind(
            line.source_line_ref,
            line.source_ref,
            line.line_id,
            line.sku,
            line.title,
            line.quantity,
            line.unit_price_minor,
            line.currency,
            boolIn(line.requires_shipping),
          )
          .run();
      }
    },
    async getRequest(ref) {
      const row = await db
        .prepare(
          `SELECT source_request_ref, source_ref, source_location_ref, state,
                  lines_json, reason, source_fulfilment_ref, updated_at
             FROM mock_order_source_requests WHERE source_request_ref = ?`,
        )
        .bind(ref)
        .first<RequestRecord>();
      return row ?? null;
    },
    async putRequest(request) {
      await db
        .prepare(
          `INSERT INTO mock_order_source_requests
             (source_request_ref, source_ref, source_location_ref, state,
              lines_json, reason, source_fulfilment_ref, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_request_ref) DO UPDATE SET
             state = excluded.state, lines_json = excluded.lines_json,
             reason = excluded.reason, source_fulfilment_ref = excluded.source_fulfilment_ref,
             updated_at = excluded.updated_at`,
        )
        .bind(
          request.source_request_ref,
          request.source_ref,
          request.source_location_ref,
          request.state,
          request.lines_json,
          request.reason,
          request.source_fulfilment_ref,
          request.updated_at,
        )
        .run();
    },
    async listLocations() {
      const res = await db
        .prepare(
          `SELECT source_location_ref, name, country, active
             FROM mock_order_source_locations ORDER BY source_location_ref`,
        )
        .all<LocationRecord & { active: unknown }>();
      return res.results.map((r) => ({ ...r, active: boolOut(r.active) }));
    },
    async putLocation(location) {
      await db
        .prepare(
          `INSERT INTO mock_order_source_locations (source_location_ref, name, country, active)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_location_ref) DO UPDATE SET
             name = excluded.name, country = excluded.country, active = excluded.active`,
        )
        .bind(location.source_location_ref, location.name, location.country, boolIn(location.active))
        .run();
    },
    async putStock(level) {
      await db
        .prepare(
          `INSERT INTO mock_order_source_stock (source_location_ref, sku, on_hand, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_location_ref, sku) DO UPDATE SET
             on_hand = excluded.on_hand, updated_at = excluded.updated_at`,
        )
        .bind(level.source_location_ref, level.sku, level.on_hand, level.updated_at)
        .run();
    },
    async getStock(sourceLocationRef, sku) {
      const row = await db
        .prepare(
          `SELECT source_location_ref, sku, on_hand, updated_at
             FROM mock_order_source_stock WHERE source_location_ref = ? AND sku = ?`,
        )
        .bind(sourceLocationRef, sku)
        .first<StockRecord>();
      return row ?? null;
    },
  };
}

/** The same seed migration 0001 writes, so both stores answer alike. */
export function memoryStore(): OrderSourceStore {
  const orders = new Map<string, OrderRecord>([[SEED_ORDER.source_ref, { ...SEED_ORDER }]]);
  const lines = new Map<string, LineRecord>(SEED_LINES.map((l) => [l.source_line_ref, { ...l }]));
  const requests = new Map<string, RequestRecord>([[SEED_REQUEST.source_request_ref, { ...SEED_REQUEST }]]);
  const locations = new Map<string, LocationRecord>(
    SEED_LOCATIONS.map((l) => [l.source_location_ref, { ...l }]),
  );
  const stock = new Map<string, StockRecord>();

  return {
    async getOrder(sourceRef) {
      return orders.get(sourceRef) ?? null;
    },
    async putOrder(order) {
      orders.set(order.source_ref, { ...order });
    },
    async listLines(sourceRef) {
      return [...lines.values()]
        .filter((l) => l.source_ref === sourceRef)
        .sort((a, b) => a.source_line_ref.localeCompare(b.source_line_ref))
        .map((l) => ({ ...l }));
    },
    async putLines(next) {
      for (const line of next) if (!lines.has(line.source_line_ref)) lines.set(line.source_line_ref, { ...line });
    },
    async getRequest(ref) {
      return requests.get(ref) ?? null;
    },
    async putRequest(request) {
      requests.set(request.source_request_ref, { ...request });
    },
    async listLocations() {
      return [...locations.values()]
        .sort((a, b) => a.source_location_ref.localeCompare(b.source_location_ref))
        .map((l) => ({ ...l }));
    },
    async putLocation(location) {
      locations.set(location.source_location_ref, { ...location });
    },
    async putStock(level) {
      stock.set(`${level.source_location_ref}::${level.sku}`, { ...level });
    },
    async getStock(ref, sku) {
      return stock.get(`${ref}::${sku}`) ?? null;
    },
  };
}
