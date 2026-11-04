-- The shipment ref the last ship emitted (migration 3).
--
-- IMMUTABLE once shipped, like 0001 and 0002.
--
-- `mock_warehouse_advance to=ship` takes an optional `shipment_ref`, so a
-- shakedown can re-ship a request under a new ref the way a carrier hand-off
-- does. Scans must hang off that ref afterwards, so it is kept on the row.
-- Empty means the default `mws_<fulfilment_request_id>`.

ALTER TABLE mock_warehouse_requests ADD COLUMN shipment_ref TEXT NOT NULL DEFAULT '';
