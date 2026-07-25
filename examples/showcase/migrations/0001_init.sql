-- Per-install D1 schema for the Showcase reference app.
--
-- D1 is allocated one-per-install by the marketplace runtime and bound
-- as env.DB to handlers + Next.js route code. Under `sprigr app dev` the
-- same file backs a local SQLite database.
--
-- NOTE: this file is IMMUTABLE once shipped (see repo CLAUDE.md).
-- Schema changes go in new numbered migration files.

-- OAuth token store + handler-written secrets (refresh_token, access_token,
-- expires_at, ...). Backs @sprigr/apps-d1-kv makeD1TokenStore.
CREATE TABLE showcase_secrets (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Non-secret key-value settings: OAuth CSRF, account id/name, sync flags.
-- Backs @sprigr/apps-d1-kv makeSettingsStore.
CREATE TABLE showcase_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Webhook / event dedup ledger. Backs @sprigr/apps-dedup-latch: one row
-- per (delivery id), claimed with a TTL so a provider re-delivery within
-- the window is a no-op. Column shape is fixed by the package
-- (id, claimed_at, expires_at); a daily sweep deletes expired rows.
CREATE TABLE showcase_webhook_dedup (
  id          TEXT PRIMARY KEY,
  claimed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE INDEX idx_showcase_webhook_dedup_expires
  ON showcase_webhook_dedup(expires_at);

-- Resumable sync cursor per (resource, scope). Backs
-- @sprigr/apps-sync-cursor makeSyncState: the durable backfill job stores
-- the "next page" cursor here so a crashed/retried step resumes cleanly.
CREATE TABLE showcase_sync_state (
  resource     TEXT NOT NULL,
  scope        TEXT NOT NULL,
  cursor       TEXT,
  last_run_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (resource, scope)
);

-- Per-tenant webhook registry for the SHARED app-level webhook. Maps an
-- Acme workspace id -> the local record so registerWebhookTenant fan-out
-- resolves an inbound shared event to this install. Backs
-- @sprigr/apps-webhook-registry makeWebhookRegistry.
CREATE TABLE showcase_webhook_tenants (
  tenant_id    TEXT PRIMARY KEY,
  path         TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
