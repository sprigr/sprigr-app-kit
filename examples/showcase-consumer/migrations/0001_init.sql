-- Per-install D1 schema for the Showcase Consumer app. IMMUTABLE once shipped.

CREATE TABLE consumer_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Install-config override: the portal writes app_installations.config; the
-- app mirrors the values it needs at runtime into this D1-local row (UPSERT)
-- so a handler reads them without a platform round-trip.
CREATE TABLE consumer_install_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
