-- Per-install D1 schema for the mock-warehouse example.
--
-- IMMUTABLE once shipped. One table: a mock warehouse has exactly one thing
-- to remember, which is what it was asked to fulfil and how far along it is.
--
-- This is the idempotency record for `push_order`. The row is written on a
-- MISS: a repeat push of the same fulfilment_request_id reads it and returns
-- the stored provider_ref without touching the vendor or writing again. D1
-- charges per row written, so "read first, write only when absent" is the
-- rule here as everywhere else.
--
-- There is deliberately no per-event audit table. Advancing a request
-- rewrites the one row and reports through env.SPRIGR.log(); a row per event
-- would be a bill, not a feature.

CREATE TABLE mock_warehouse_requests (
  fulfilment_request_id  TEXT PRIMARY KEY,
  provider_ref           TEXT NOT NULL,
  order_id               TEXT NOT NULL,
  warehouse_key          TEXT NOT NULL,
  lines_json             TEXT NOT NULL,
  -- queued -> accepted -> shipped, with cancelled off the ladder.
  stage                  TEXT NOT NULL,
  carrier                TEXT NOT NULL DEFAULT '',
  tracking_number        TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
