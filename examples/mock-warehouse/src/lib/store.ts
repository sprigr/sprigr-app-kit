/**
 * mock-warehouse - the request store.
 *
 * Two implementations behind one interface: the per-install D1 table the
 * platform binds, and an in-memory map. The in-memory one is what lets the
 * conformance harness drive the REAL handler map (not a stand-in) with no D1
 * binding, which is the whole point of shipping this app as a fixture.
 */

import type { D1Like } from '@sprigr/apps-app-sdk';

export type RequestStage = 'queued' | 'accepted' | 'shipped' | 'cancelled';

export interface RequestRecord {
  fulfilment_request_id: string;
  provider_ref: string;
  order_id: string;
  warehouse_key: string;
  lines_json: string;
  stage: RequestStage;
  carrier: string;
  tracking_number: string;
  created_at: string;
  updated_at: string;
}

export interface WarehouseStore {
  get(fulfilmentRequestId: string): Promise<RequestRecord | null>;
  /** Insert only. The caller reads first, so this never fires on a repeat push. */
  insert(record: RequestRecord): Promise<void>;
  update(
    fulfilmentRequestId: string,
    patch: Pick<RequestRecord, 'stage' | 'carrier' | 'tracking_number' | 'updated_at'>,
  ): Promise<void>;
}

export function d1Store(db: D1Like): WarehouseStore {
  return {
    async get(id) {
      return db
        .prepare(
          `SELECT fulfilment_request_id, provider_ref, order_id, warehouse_key, lines_json,
                  stage, carrier, tracking_number, created_at, updated_at
             FROM mock_warehouse_requests WHERE fulfilment_request_id = ?`,
        )
        .bind(id)
        .first<RequestRecord>();
    },
    async insert(record) {
      await db
        .prepare(
          `INSERT INTO mock_warehouse_requests
             (fulfilment_request_id, provider_ref, order_id, warehouse_key, lines_json,
              stage, carrier, tracking_number, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          record.created_at,
          record.updated_at,
        )
        .run();
    },
    async update(id, patch) {
      await db
        .prepare(
          `UPDATE mock_warehouse_requests
              SET stage = ?, carrier = ?, tracking_number = ?, updated_at = ?
            WHERE fulfilment_request_id = ?`,
        )
        .bind(patch.stage, patch.carrier, patch.tracking_number, patch.updated_at, id)
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
    async insert(record) {
      if (!rows.has(record.fulfilment_request_id)) rows.set(record.fulfilment_request_id, { ...record });
    },
    async update(id, patch) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...patch });
    },
  };
}
