-- Per-install D1 schema for the Harvest marketplace app.
--
-- D1 is allocated one-per-install by the marketplace runtime and bound
-- as env.DB to handlers + Next.js route code.
--
-- NOTE: this file is IMMUTABLE once shipped (see repo CLAUDE.md).
-- Schema changes go in new numbered migration files.

-- Key-value table backing the OAuth TokenStore / handler-written
-- secrets (refresh_token, access_token, expires_at, ...).
CREATE TABLE harvest_secrets (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Non-secret key-value settings: OAuth CSRF, feature toggles,
-- sync cursors, etc.
CREATE TABLE harvest_settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
