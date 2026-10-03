/**
 * The two apps' file-indexing schemas as their migrations leave them
 * (sprigr-apps origin/staging 46452a28c). google-workspace: 0004, 0005, 0012,
 * 0013. microsoft-365: 0003, 0005, 0006, 0013 (the per-connection rebuild),
 * 0016, 0022, 0024. Copied column for column so the store is tested against
 * the real shapes, including what one app has and the other lacks.
 */

export const GOOGLE_WORKSPACE_SCHEMA = `
CREATE TABLE gw_file_indexing (
  sprigr_user_id   TEXT,
  sprigr_agent_id  TEXT,
  enabled          INTEGER NOT NULL DEFAULT 0,
  page_token       TEXT,
  connected_email  TEXT,
  last_indexed_at  INTEGER,
  last_status      TEXT,
  last_error       TEXT,
  files_indexed    INTEGER NOT NULL DEFAULT 0,
  files_skipped    INTEGER NOT NULL DEFAULT 0,
  full_walk_active INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (sprigr_user_id, sprigr_agent_id)
);
CREATE TABLE gw_walk_seen (
  actor_key  TEXT NOT NULL,
  object_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_key, object_id)
);
CREATE TABLE gw_pending_extractions (
  object_id   TEXT PRIMARY KEY,
  job_token   TEXT NOT NULL,
  record_json TEXT NOT NULL,
  format      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
ALTER TABLE gw_file_indexing ADD COLUMN walk_list_token TEXT;
ALTER TABLE gw_file_indexing ADD COLUMN walk_start_token TEXT;
ALTER TABLE gw_file_indexing ADD COLUMN identity_link_refused_at INTEGER;
`;

export const MICROSOFT_365_SCHEMA = `
CREATE TABLE ms_file_indexing (
  sprigr_user_id   TEXT,
  sprigr_agent_id  TEXT,
  enabled          INTEGER NOT NULL DEFAULT 0,
  delta_link       TEXT,
  connected_email  TEXT,
  tenant_id        TEXT,
  last_indexed_at  INTEGER,
  last_status      TEXT,
  last_error       TEXT,
  files_indexed    INTEGER NOT NULL DEFAULT 0,
  files_skipped    INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  full_walk_active INTEGER NOT NULL DEFAULT 0,
  connection_id    TEXT NOT NULL,
  UNIQUE (sprigr_user_id, sprigr_agent_id, connection_id)
);
CREATE TABLE ms_walk_seen (
  actor_key  TEXT NOT NULL,
  object_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_key, object_id)
);
CREATE TABLE ms_pending_extractions (
  object_id   TEXT PRIMARY KEY,
  job_token   TEXT NOT NULL,
  record_json TEXT NOT NULL,
  format      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
ALTER TABLE ms_file_indexing ADD COLUMN sp_auto_drives TEXT;
ALTER TABLE ms_file_indexing ADD COLUMN sp_auto_at     INTEGER;
ALTER TABLE ms_file_indexing ADD COLUMN sp_walk_next   TEXT;
ALTER TABLE ms_file_indexing ADD COLUMN identity_link_refused_at INTEGER;
ALTER TABLE ms_file_indexing ADD COLUMN acl_refresh_link TEXT;
ALTER TABLE ms_file_indexing ADD COLUMN acl_refresh_completed_at INTEGER;
`;

/** The column the package recommends each app add for the bounded #2419 hold. */
export const HELD_SINCE_MIGRATION = (table: string) =>
  `ALTER TABLE ${table} ADD COLUMN unresolved_held_since INTEGER;`;
