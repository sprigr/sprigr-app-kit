-- Inbound purchase orders (migration 4).
--
-- IMMUTABLE once shipped, like 0001 to 0003.
--
-- `create_inbound` (fulfilment_provider 1.5.0) is idempotent on the hub's
-- inbound_id, so the PO is claimed here before anything else and a repeat
-- answers from the row. One row per PO: the lines and their cumulative
-- received counts are a JSON column rewritten by the inbound lever, never a
-- row per delivery (D1 charges per row written, the same reasoning as 0001).

CREATE TABLE mock_warehouse_inbounds (
  inbound_id      TEXT PRIMARY KEY,
  provider_ref    TEXT NOT NULL,
  po_number       TEXT NOT NULL,
  warehouse_key   TEXT NOT NULL,
  -- [{ line_id, sku, quantity, received_quantity }]
  lines_json      TEXT NOT NULL,
  -- queued -> accepted -> partially_received -> received, with refused off the ladder.
  stage           TEXT NOT NULL,
  delivery_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
