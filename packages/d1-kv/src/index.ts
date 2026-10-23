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
 * The value-level AES-GCM envelope the token store uses, for an app whose
 * credentials live in its own columns rather than a key/value table (e.g.
 * slack's `bot_token` / `user_token`, sprigr-team#9825). Same envelope, same
 * KEK derivation, so a value sealed here reads back through a token store
 * and vice versa. `decryptValue` passes a value WITHOUT the envelope through
 * unchanged, which is what a read-both migration needs; `label` names the
 * column for the error message and must never be the value.
 */
export { encryptValue, decryptValue } from './token-crypto';

export type { D1Like, D1PreparedStatementLike } from './types';
