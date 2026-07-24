/**
 * D1-backed `TokenStore` for @sprigr/apps-oauth-utils.
 *
 * The structural shape (get / put / delete) matches `TokenStore` in
 * oauth-utils so this can be passed directly to `getValidAccessToken`,
 * `exchangeAuthorizationCode`, etc. We intentionally do NOT import
 * the type from oauth-utils so this package stays self-contained when
 * vendored.
 *
 * Schema this expects (mirrors the settings store):
 *   CREATE TABLE <app>_secrets (
 *     key        TEXT PRIMARY KEY,
 *     value      TEXT NOT NULL,
 *     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
 *   );
 *
 * Why D1 instead of `env.SECRETS`: the marketplace runtime doesn't
 * yet expose handler-side secret rotation. Manifest `secrets[]`
 * binds at install time and is read-only. OAuth refresh-rotation
 * needs writes from the running handler. Per-install D1 is the
 * isolated, encrypted-at-rest, transactional alternative. When
 * `env.SPRIGR.secrets.set()` ships, migrate to that API and keep
 * this as the legacy adapter for older apps.
 */

import type { D1Like } from './types';

export interface TokenStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface MakeD1TokenStoreOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration. */
  table: string;
}

export function makeD1TokenStore(opts: MakeD1TokenStoreOpts): TokenStore {
  const { db, table } = opts;
  assertIdent(table);

  return {
    async get(key) {
      const row = await db
        .prepare(`SELECT value FROM ${table} WHERE key = ?`)
        .bind(key)
        .first<{ value: string }>();
      return row?.value ?? null;
    },
    async put(key, value) {
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
