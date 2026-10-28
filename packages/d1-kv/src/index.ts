/**
 * @sprigr/apps-d1-kv
 *
 * Per-install D1 key-value helpers. Two flavours of the same underlying
 * table shape:
 *
 *   `makeSettingsStore` — generic key/value, with `getAll` for listing.
 *   `makeD1TokenStore`  — `TokenStore`-compatible (oauth-utils),
 *                         no `getAll`, `put` instead of `set`. Holds
 *                         credential material, so it takes a required
 *                         `encryption` option (AES-GCM at rest under an
 *                         install KEK); see token-store.ts.
 *
 * `encryptValue` / `decryptValue` expose that envelope on its own, for a
 * credential column outside a key/value table; see token-crypto.ts.
 *
 * Both expect a table with `(key TEXT PRIMARY KEY, value TEXT NOT NULL,
 * updated_at TEXT NOT NULL)`. Apps own the migrations.
 */

export { makeSettingsStore } from './settings-store';
export type { SettingsStore, MakeSettingsStoreOpts } from './settings-store';

export { makeD1TokenStore } from './token-store';
export type {
  TokenStore,
  MakeD1TokenStoreOpts,
  TokenStoreEncryption,
} from './token-store';

export { ENVELOPE_PREFIX, isEncryptedValue } from './token-crypto';

/**
 * The envelope itself, for credential material that does not live in a
 * key/value table: a column on a per-user row, for example. Same
 * construction and format `makeD1TokenStore` writes, so a value sealed here
 * opens through the store and the other way round. The caller owns the
 * migration story the store handles for its own table (reading both forms,
 * and re-sealing a legacy cleartext value with a compare-and-set).
 */
export { encryptValue, decryptValue } from './token-crypto';

export type { D1Like, D1PreparedStatementLike } from './types';
