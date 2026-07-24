/**
 * Per-install resumable cursor state, backed by D1.
 *
 * A provider-agnostic key-value table where each row tracks where a
 * paginated walk through some external resource has reached. Pair it
 * with `runResumablePage` for a self-paging backfill loop.
 *
 * Schema this expects (apps own the migration; pick whatever table
 * name suits, the package only requires the column shape):
 *
 *   CREATE TABLE <app>_sync_state (
 *     resource     TEXT NOT NULL,
 *     scope        TEXT NOT NULL DEFAULT '',
 *     cursor       TEXT,
 *     last_run_at  TEXT NOT NULL DEFAULT (datetime('now')),
 *     PRIMARY KEY (resource, scope)
 *   );
 *
 * The `scope` column is the partition key beneath `resource`. Apps
 * use it for any sub-partition they need (per project, per store,
 * per workspace, ...). Apps that don't need scoping pass it as
 * undefined; the store coerces to the empty string so the compound
 * primary key still works.
 *
 * `cursor` semantics are app-defined: an ISO timestamp, an opaque
 * page-info token, a numeric offset, whatever the provider exposes.
 * Null means "not started yet" (or after clear()).
 */

import type { D1Like } from './types';

export interface SyncStateRow {
  resource: string;
  scope: string;
  cursor: string | null;
  lastRunAt: string;
}

export interface SyncState {
  read(resource: string, scope?: string): Promise<SyncStateRow | null>;
  write(resource: string, scope: string | undefined, cursor: string | null): Promise<void>;
  clear(resource: string, scope?: string): Promise<void>;
  list(): Promise<SyncStateRow[]>;
}

export interface MakeSyncStateOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration. */
  table: string;
}

export function makeSyncState(opts: MakeSyncStateOpts): SyncState {
  const { db, table } = opts;
  assertIdent(table);

  return {
    async read(resource, scope) {
      const s = scope ?? '';
      const row = await db
        .prepare(
          `SELECT resource, scope, cursor, last_run_at AS lastRunAt
             FROM ${table}
            WHERE resource = ? AND scope = ?`,
        )
        .bind(resource, s)
        .first<SyncStateRow>();
      return row ?? null;
    },
    async write(resource, scope, cursor) {
      const s = scope ?? '';
      await db
        .prepare(
          `INSERT INTO ${table} (resource, scope, cursor, last_run_at)
             VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(resource, scope) DO UPDATE SET
             cursor = excluded.cursor,
             last_run_at = datetime('now')`,
        )
        .bind(resource, s, cursor)
        .run();
    },
    async clear(resource, scope) {
      const s = scope ?? '';
      await db
        .prepare(`DELETE FROM ${table} WHERE resource = ? AND scope = ?`)
        .bind(resource, s)
        .run();
    },
    async list() {
      const result = await db
        .prepare(
          `SELECT resource, scope, cursor, last_run_at AS lastRunAt
             FROM ${table}
            ORDER BY resource, scope`,
        )
        .all<SyncStateRow>();
      return result.results ?? [];
    },
  };
}

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name: string): void {
  if (!IDENT_RX.test(name)) {
    throw new Error(
      `sync-cursor: table name "${name}" is not a plain SQL identifier`,
    );
  }
}
