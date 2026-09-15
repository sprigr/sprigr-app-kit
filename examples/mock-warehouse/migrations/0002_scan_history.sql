-- Carrier scans and the delivery stamp (migration 2).
--
-- IMMUTABLE once shipped, like 0001.
--
-- `mock_warehouse_advance to=scan|deliver` emits provider.shipment.event,
-- the contract's carrier-scan callback. The mock has to remember what it
-- already emitted, for two reasons: the event ref is
-- mwe_<request>_<stage>_<n>, so minting the next one needs the count of that
-- stage; and the delivery KPIs want a delivered_at on the request.
--
-- It stays ONE ROW PER REQUEST. The scan history is a JSON array on the
-- existing row, rewritten when a scan lands, not a per-event table: D1
-- charges per row written and a scan-per-row table would be a bill, not a
-- feature. The same reasoning is on 0001.

ALTER TABLE mock_warehouse_requests ADD COLUMN scans_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mock_warehouse_requests ADD COLUMN delivered_at TEXT NOT NULL DEFAULT '';
