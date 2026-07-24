/**
 * @sprigr/apps-d1-kv
 *
 * Per-install D1 key-value helpers. Two flavours of the same underlying
 * table shape:
 *
 *   `makeSettingsStore` — generic key/value, with `getAll` for listing.
 *   `makeD1TokenStore`  — `TokenStore`-compatible (oauth-utils),
 *                         no `getAll`, `put` instead of `set`.
 *
 * Both expect a table with `(key TEXT PRIMARY KEY, value TEXT NOT NULL,
 * updated_at TEXT NOT NULL)`. Apps own the migrations.
 */

export { makeSettingsStore } from './settings-store';
export type { SettingsStore, MakeSettingsStoreOpts } from './settings-store';

export { makeD1TokenStore } from './token-store';
export type { TokenStore, MakeD1TokenStoreOpts } from './token-store';

export type { D1Like, D1PreparedStatementLike } from './types';
