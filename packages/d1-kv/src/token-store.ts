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
 * isolated, transactional alternative. When `env.SPRIGR.secrets.set()`
 * ships, migrate to that API and keep this as the legacy adapter for
 * older apps.
 *
 * ── At-rest encryption ─────────────────────────────────────────────
 *
 * The rows this table holds are long-lived provider credentials:
 * OAuth refresh tokens, access tokens, and in a few apps the OAuth
 * client secret itself. They used to be written as plain TEXT.
 * `apps/email-imap-pop` already wraps its mailbox passwords in AES-GCM
 * under an install KEK, so the repo already treats per-install D1 as
 * insufficiently trusted for credential material; this store now uses
 * the same construction (see `token-crypto.ts`).
 *
 * `encryption` is a REQUIRED option with no default. There is no
 * silent cleartext fallback: an app either supplies a key, or states
 * in code why it is not encrypting. A missing key throws.
 *
 * Migration, and why nothing existing breaks:
 *
 *   - Encrypted values carry a `sprigr.enc.v1.` prefix. Anything
 *     without it is a pre-existing cleartext row.
 *   - `get` decrypts a prefixed value and returns an unprefixed one
 *     unchanged, so every currently-connected install keeps working
 *     with no backfill and no migration file.
 *   - In `encrypt` mode, `put` always writes sealed, and `get`
 *     lazily re-seals a legacy row it just read, so installs whose
 *     refresh token never rotates still migrate.
 *   - `decrypt-only` mode is the rollback-safe first release: it can
 *     read sealed values but keeps writing cleartext, so a rollback to
 *     a build that predates this file can still read every row. Flip an
 *     app to `encrypt` once the decrypt-capable build is the floor you
 *     would roll back to.
 */

import type { D1Like } from './types';
import { decryptValue, encryptValue, isEncryptedValue } from './token-crypto';

export interface TokenStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

/**
 * How this store treats value material. Explicit, and required, because
 * the failure mode of a default is silent: a store that quietly wrote
 * cleartext would look identical to one that worked.
 */
export type TokenStoreEncryption =
  /**
   * Seal every write, read both sealed and legacy-cleartext rows, and
   * re-seal a legacy row on read. The end state for every app.
   * `kek` is the install's key-encryption secret; an absent or empty
   * one throws on first use rather than degrading to cleartext.
   */
  | { mode: 'encrypt'; kek: string | undefined }
  /**
   * Read sealed rows, keep writing cleartext. The rollback-safe step
   * between "nothing understands the envelope" and `encrypt`: after
   * this ships, a build that reads sealed values is everywhere, so
   * flipping to `encrypt` can no longer be rolled back into a reader
   * that would hand ciphertext to a provider.
   */
  | { mode: 'decrypt-only'; kek: string | undefined }
  /**
   * No crypto. Reserved for stores that hold no credential material.
   * `reason` is mandatory and exists to make this a decision somebody
   * wrote down, never something that happened by omission.
   */
  | { mode: 'cleartext'; reason: string };

export interface MakeD1TokenStoreOpts {
  db: D1Like;
  /** Table name. Must already exist via the app's migration. */
  table: string;
  /** Required. See `TokenStoreEncryption`; there is no default. */
  encryption: TokenStoreEncryption;
}

export function makeD1TokenStore(opts: MakeD1TokenStoreOpts): TokenStore {
  const { db, table, encryption } = opts;
  assertIdent(table);
  assertEncryption(table, encryption);

  const kek = encryption.mode === 'cleartext' ? undefined : encryption.kek;
  const sealsWrites = encryption.mode === 'encrypt';
  const readsSealed = encryption.mode !== 'cleartext';

  async function readRaw(key: string): Promise<string | null> {
    const row = await db
      .prepare(`SELECT value FROM ${table} WHERE key = ?`)
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async function writeRaw(key: string, value: string): Promise<void> {
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
  }

  return {
    async get(key) {
      const stored = await readRaw(key);
      if (stored === null) return null;

      if (!isEncryptedValue(stored)) {
        // A pre-existing cleartext row. Hand it back, and in encrypt mode
        // take the opportunity to seal it so an install whose token never
        // rotates does not stay in cleartext forever.
        if (sealsWrites) await reseal(key, stored);
        return stored;
      }

      if (!readsSealed) {
        // Configured for cleartext but the row is sealed: this store was
        // pointed at data written by an encrypting build. Returning the
        // envelope verbatim would ship ciphertext to a provider as if it
        // were a token, so fail instead.
        throw new Error(
          `d1-kv: ${table}.${key} is encrypted but this store is configured ` +
            'mode "cleartext". Supply the install key-encryption key.',
        );
      }

      return decryptValue(kek, stored, `${table}.${key}`);
    },

    async put(key, value) {
      await writeRaw(key, sealsWrites ? await encryptValue(kek, value) : value);
    },

    async delete(key) {
      await db.prepare(`DELETE FROM ${table} WHERE key = ?`).bind(key).run();
    },
  };

  /**
   * Best-effort lazy migration of one legacy row.
   *
   * Failure here must not fail the read: the caller already has a usable
   * token, and an install that cannot write (a read-replica hiccup, a
   * transient D1 error) should still be able to call its provider. The
   * next `put` re-seals it anyway. The warning names the row, never the
   * value.
   */
  async function reseal(key: string, plaintext: string): Promise<void> {
    try {
      await writeRaw(key, await encryptValue(kek, plaintext));
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      console.warn(`[d1-kv] could not re-encrypt ${table}.${key} in place: ${detail}`);
    }
  }
}

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name: string): void {
  if (!IDENT_RX.test(name)) {
    throw new Error(
      `d1-kv: table name "${name}" is not a plain SQL identifier`,
    );
  }
}

/**
 * Reject a malformed `encryption` option at construction time.
 *
 * Construction is the closest thing a Worker has to startup, and it is
 * where an operator can still act on the message. Discovering a missing
 * KEK on the first token refresh instead would surface as an opaque
 * provider auth failure hours later.
 */
function assertEncryption(table: string, encryption: TokenStoreEncryption): void {
  if (encryption.mode === 'cleartext') {
    if (typeof encryption.reason !== 'string' || encryption.reason.trim().length === 0) {
      throw new Error(
        `d1-kv: ${table} was constructed with encryption mode "cleartext" and no reason. ` +
          'State why this table holds no credential material.',
      );
    }
    return;
  }
  if (typeof encryption.kek !== 'string' || encryption.kek.trim().length === 0) {
    throw new Error(
      `d1-kv: ${table} needs a key-encryption key for mode "${encryption.mode}" and none was set ` +
        'on this install. Set the install secret this app declares for it ' +
        '(32 random bytes, base64) and reconnect. The store will not fall back to cleartext.',
    );
  }
}
