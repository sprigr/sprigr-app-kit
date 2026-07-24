/**
 * Per-install D1 key-value settings store.
 *
 * The standard shape every app's `<app>_settings` table follows:
 *   CREATE TABLE <app>_settings (
 *     key        TEXT PRIMARY KEY,
 *     value      TEXT NOT NULL,
 *     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
 *   );
 *
 * Apps pick their own table name. The store is structural: it expects
 * the `key`, `value`, `updated_at` columns named exactly that.
 *
 * Use this for non-sensitive install-scoped state: selected environment,
 * external company id pinned by the brand, webhook secrets the app
 * registered itself, sync cursors, feature toggles. For OAuth tokens
 * (refresh-rotated), use `makeD1TokenStore` instead so the shape is
 * compatible with @sprigr/apps-oauth-utils.
 */

import type { D1Like } from './types';

export interface SettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  getAll(): Promise<Record<string, string>>;
}

export interface MakeSettingsStoreOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration. */
  table: string;
}

export function makeSettingsStore(opts: MakeSettingsStoreOpts): SettingsStore {
  const { db, table } = opts;
  // Table name comes from the app's own manifest-declared migrations,
  // never from user input. SQLite cannot parameterise identifiers, so
  // direct interpolation is the only option. Reject anything that
  // isn't a plain identifier to keep this safe even when callers get
  // sloppy about constants.
  assertIdent(table);

  return {
    async get(key) {
      const row = await db
        .prepare(`SELECT value FROM ${table} WHERE key = ?`)
        .bind(key)
        .first<{ value: string }>();
      return row?.value ?? null;
    },
    async set(key, value) {
      await db
        .prepare(
          `INSERT INTO ${table} (key, value, updated_at)
             VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = datetime('now')`,
        )
        .bind(key, value)
        .run();
    },
    async delete(key) {
      await db.prepare(`DELETE FROM ${table} WHERE key = ?`).bind(key).run();
    },
    async getAll() {
      const rows = await db
        .prepare(`SELECT key, value FROM ${table}`)
        .all<{ key: string; value: string }>();
      const out: Record<string, string> = {};
      for (const r of rows.results ?? []) out[r.key] = r.value;
      return out;
    },
  };
}

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name: string): void {
  if (!IDENT_RX.test(name)) {
    throw new Error(
      `d1-kv: table name "${name}" is not a plain SQL identifier`,
    );
  }
}
