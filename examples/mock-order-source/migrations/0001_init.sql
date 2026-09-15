-- Per-install D1 schema for the mock-order-source example.
--
-- IMMUTABLE once shipped. These tables are the selling system: an order
-- source's job is to hand the hub the contract's canonical `order` and
-- `order_line` shapes, so the columns are named after those fields rather
-- than after some internal model that would need translating on every read.
--
-- No audit table. Placing and advancing an order rewrites the rows it owns
-- and reports through env.SPRIGR.log(); D1 charges per row written, so a row
-- per event would be a bill.

CREATE TABLE mock_order_source_orders (
  source_ref       TEXT PRIMARY KEY,
  source_number    TEXT NOT NULL,
  status           TEXT NOT NULL,
  placed_at        TEXT NOT NULL,
  currency         TEXT NOT NULL,
  total_minor      INTEGER NOT NULL,
  customer_email   TEXT NOT NULL DEFAULT '',
  ship_to_json     TEXT NOT NULL DEFAULT '{}',
  tags_json        TEXT NOT NULL DEFAULT '[]',
  notes_json       TEXT NOT NULL DEFAULT '[]',
  hold_reason      TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL
);

CREATE TABLE mock_order_source_lines (
  source_line_ref   TEXT PRIMARY KEY,
  source_ref        TEXT NOT NULL,
  line_id           TEXT NOT NULL,
  sku               TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  quantity          INTEGER NOT NULL,
  unit_price_minor  INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  requires_shipping INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX mock_order_source_lines_by_order ON mock_order_source_lines (source_ref);

CREATE TABLE mock_order_source_requests (
  source_request_ref     TEXT PRIMARY KEY,
  source_ref             TEXT NOT NULL,
  source_location_ref    TEXT NOT NULL,
  state                  TEXT NOT NULL,
  lines_json             TEXT NOT NULL,
  reason                 TEXT NOT NULL DEFAULT '',
  source_fulfilment_ref  TEXT NOT NULL DEFAULT '',
  updated_at             TEXT NOT NULL
);

CREATE TABLE mock_order_source_locations (
  source_location_ref  TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  country              TEXT NOT NULL,
  active               INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE mock_order_source_stock (
  source_location_ref  TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  on_hand              INTEGER NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (source_location_ref, sku)
);

-- Seed. A fresh install can answer get_order and drive the whole request
-- lifecycle before anyone has placed anything, which is what makes this a
-- usable shakedown fixture on install rather than after a setup step.
-- src/lib/records.ts holds the same values for the in-memory store, and
-- __tests__/seed.test.ts fails if the two drift.
INSERT INTO mock_order_source_locations (source_location_ref, name, country, active) VALUES
  ('mos_loc_bne', 'Mock Source Brisbane', 'AU', 1),
  ('mos_loc_syd', 'Mock Source Sydney', 'AU', 1);

INSERT INTO mock_order_source_orders
  (source_ref, source_number, status, placed_at, currency, total_minor,
   customer_email, ship_to_json, tags_json, notes_json, hold_reason, updated_at)
VALUES
  ('mos_seed_1', 'MOS-1001', 'received', '2026-09-01T00:00:00Z', 'AUD', 4500,
   'seed.buyer@example.test',
   '{"name":"Seed Buyer","line1":"1 Seed Street","city":"Brisbane","region":"QLD","postcode":"4000","country":"AU"}',
   '["seed"]', '[]', '', '2026-09-01T00:00:00Z');

INSERT INTO mock_order_source_lines
  (source_line_ref, source_ref, line_id, sku, title, quantity, unit_price_minor, currency, requires_shipping)
VALUES
  ('mos_seed_1_l1', 'mos_seed_1', 'mos_seed_1_l1', 'CONF-SKU-1', 'Seed widget', 2, 1500, 'AUD', 1),
  ('mos_seed_1_l2', 'mos_seed_1', 'mos_seed_1_l2', 'CONF-SKU-2', 'Seed gadget', 1, 1500, 'AUD', 1);

INSERT INTO mock_order_source_requests
  (source_request_ref, source_ref, source_location_ref, state, lines_json, reason, source_fulfilment_ref, updated_at)
VALUES
  ('mos_seed_1_r1', 'mos_seed_1', 'mos_loc_bne', 'submitted',
   '[{"source_line_ref":"mos_seed_1_l1","sku":"CONF-SKU-1","quantity":2},{"source_line_ref":"mos_seed_1_l2","sku":"CONF-SKU-2","quantity":1}]',
   '', '', '2026-09-01T00:00:00Z');
