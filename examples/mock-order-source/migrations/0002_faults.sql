-- Fault lever for the hub's resend shakedown (sprigr-apps#3474): an armed
-- op answers `error` this many more times before it runs for real.
CREATE TABLE mock_order_source_faults (
  op         TEXT PRIMARY KEY,
  remaining  INTEGER NOT NULL
);
