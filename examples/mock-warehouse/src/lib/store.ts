/**
 * mock-warehouse - the request store.
 *
 * Two implementations behind one interface: the per-install D1 table the
 * platform binds, and an in-memory map. The in-memory one is what lets the
 * conformance harness drive the REAL handler map (not a stand-in) with no D1
 * binding, which is the whole point of shipping this app as a fixture.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export type RequestStage = 'pushing' | 'queued' | 'accepted' | 'shipped' | 'delivered' | 'cancelled';

export interface RequestRecord {
  fulfilment_request_id: string;
  provider_ref: string;
  order_id: string;
  warehouse_key: string;
  lines_json: string;
  stage: RequestStage;
  carrier: string;
  tracking_number: string;
  /** JSON array of ScanRecord: the carrier scans emitted for this request. */
  scans_json: string;
  /** ISO 8601 UTC, empty until the delivered scan is emitted. */
  delivered_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * The columns an advance rewrites. `scans_json` and `delivered_at` are
 * optional because most advances do not touch them: an absent key leaves the
 * stored value alone rather than blanking it, so a caller never has to read
 * the row back just to pass its own value through.
 */
export type RequestPatch = Pick<RequestRecord, 'stage' | 'carrier' | 'tracking_number' | 'updated_at'> &
  Partial<Pick<RequestRecord, 'scans_json' | 'delivered_at'>>;

export interface WarehouseStore {
  get(fulfilmentRequestId: string): Promise<RequestRecord | null>;
  /**
   * The push_order latch. Writes the record BEFORE the vendor call (stage
   * 'pushing', no provider_ref yet) and answers whether THIS call wrote it,
   * so of two deliveries of one request only one reaches the vendor.
   */
  claim(record: RequestRecord): Promise<boolean>;
  /** The winner's vendor call returned: record its ref and move the row to 'queued'. */
  setPushed(fulfilmentRequestId: string, providerRef: string, updatedAt: string): Promise<void>;
  update(fulfilmentRequestId: string, patch: RequestPatch): Promise<void>;
}

export function d1Store(db: D1Like): WarehouseStore {
  return {
    async get(id) {
      return db
        .prepare(
          `SELECT fulfilment_request_id, provider_ref, order_id, warehouse_key, lines_json,
                  stage, carrier, tracking_number, scans_json, delivered_at, created_at, updated_at
             FROM mock_warehouse_requests WHERE fulfilment_request_id = ?`,
        )
        .bind(id)
        .first<RequestRecord>();
    },
    async claim(record) {
      const result = await db
        .prepare(
          `INSERT INTO mock_warehouse_requests
             (fulfilment_request_id, provider_ref, order_id, warehouse_key, lines_json,
              stage, carrier, tracking_number, scans_json, delivered_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(fulfilment_request_id) DO NOTHING`,
        )
        .bind(
          record.fulfilment_request_id,
          record.provider_ref,
          record.order_id,
          record.warehouse_key,
          record.lines_json,
          record.stage,
          record.carrier,
          record.tracking_number,
          record.scans_json,
          record.delivered_at,
          record.created_at,
          record.updated_at,
        )
        .run();
      const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
      // Refuse to guess: false would leave every order unpushed, true would
      // let a repeat through to the vendor.
      if (typeof changes !== 'number') {
        throw new Error('D1 run() reported no meta.changes, so the push_order claim cannot tell whether it won');
      }
      return changes === 1;
    },
    async setPushed(id, providerRef, updatedAt) {
      await db
        .prepare(
          `UPDATE mock_warehouse_requests SET provider_ref = ?, stage = 'queued', updated_at = ?
            WHERE fulfilment_request_id = ? AND stage = 'pushing'`,
        )
        .bind(providerRef, updatedAt, id)
        .run();
    },
    async update(id, patch) {
      // COALESCE, not a blank write: a patch that omits the scan history or
      // the delivery stamp means "leave it", which is every advance but a
      // scan. Still one UPDATE against the one row - no per-event table.
      await db
        .prepare(
          `UPDATE mock_warehouse_requests
              SET stage = ?, carrier = ?, tracking_number = ?, updated_at = ?,
                  scans_json = COALESCE(?, scans_json),
                  delivered_at = COALESCE(?, delivered_at)
            WHERE fulfilment_request_id = ?`,
        )
        .bind(
          patch.stage,
          patch.carrier,
          patch.tracking_number,
          patch.updated_at,
          patch.scans_json ?? null,
          patch.delivered_at ?? null,
          id,
        )
        .run();
    },
  };
}

export function memoryStore(): WarehouseStore {
  const rows = new Map<string, RequestRecord>();
  return {
    async get(id) {
      return rows.get(id) ?? null;
    },
    async claim(record) {
      if (rows.has(record.fulfilment_request_id)) return false;
      rows.set(record.fulfilment_request_id, { ...record });
      return true;
    },
    async setPushed(id, providerRef, updatedAt) {
      const row = rows.get(id);
      if (row?.stage === 'pushing') rows.set(id, { ...row, provider_ref: providerRef, stage: 'queued', updated_at: updatedAt });
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (!row) return;
      // Mirror the COALESCE above: an omitted key keeps the stored value.
      const next: RequestRecord = { ...row, ...patch };
      if (patch.scans_json === undefined) next.scans_json = row.scans_json;
      if (patch.delivered_at === undefined) next.delivered_at = row.delivered_at;
      rows.set(id, next);
    },
  };
}
