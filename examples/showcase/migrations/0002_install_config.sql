-- Install-config override table (migration 2).
--
-- Some config the brand sets in the portal lands in app_installations.config
-- (JSON) on the platform. Apps that also want a queryable, D1-local copy
-- (e.g. to read decision_<id>_workflow_id inside a handler without a
-- platform round-trip) UPSERT it into their own row here. This mirrors the
-- private-repo install-config pattern, genericized.
--
-- NOTE: immutable once shipped.

CREATE TABLE showcase_install_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
