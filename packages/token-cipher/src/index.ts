/**
 * @sprigr/apps-token-cipher
 *
 * At-rest sealing for the credentials an app keeps in its own D1 columns
 * (sprigr-app-kit#225). Four sprigr-apps apps carried the same
 * `token-cipher.ts` (google-workspace, xero-accounting, microsoft-365,
 * github); this is that body once, so release B (seal on write) and the
 * backfill land in one place.
 *
 * The envelope is `@sprigr/apps-d1-kv`'s (AES-GCM under SHA-256 of the
 * install's KEK, a fresh IV per value, `sprigr.enc.v1.` prefix). The key is a
 * per-install `auto_generate` secret the platform mints once and never
 * rotates; the app passes its value and its binding name.
 *
 * Modes. `decrypt-only` (release A) reads both forms and writes cleartext; it
 * is the rollback floor for `encrypt` (release B), because a build older than
 * A cannot read a sealed value and would send it to the provider as a token.
 * Each app keeps its own mode constant, so the A to B flip stays per app.
 *
 * A sealed value that cannot be opened (no key, a wrong key, an altered
 * value) throws TokenKeyError. The caller decides what that means: an OAuth
 * app must stop the call and must never map it to invalid_grant; an app that
 * can re-mint (github's installation token) may treat it as a cache miss.
 * Messages name the field, never a value.
 */

import { decryptValue, encryptValue, isEncryptedValue } from '@sprigr/apps-d1-kv';

export type TokenCipherMode = 'decrypt-only' | 'encrypt';

/** A sealed value this install cannot open, or a value it cannot seal. */
export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenKeyError';
  }
}

export interface TokenCipherOptions {
  /** The install's key-encryption key: the value of `binding` in env. */
  kek: string | null | undefined;
  /** The manifest secret that holds the KEK, e.g. `GOOGLE_WORKSPACE_TOKEN_KEK`. Named in errors. */
  binding: string;
  /** The provider, for errors: "Nothing was sent to Google". */
  provider: string;
  mode: TokenCipherMode;
  /** What a failed seal says was not kept. Default `credential was not stored`;
   *  xero says `token was not stored`, github `token was not cached`. */
  notKept?: string;
  /** End errors with "contact support". Default true. An app whose caller
   *  recovers by itself (github re-mints) can turn it off. */
  contactSupport?: boolean;
}

export interface TokenCipher<F extends string = string> {
  /** The stored value as plaintext. Cleartext passes through untouched. */
  open(stored: string | null | undefined, field: F): Promise<string | null>;
  /** The value as it should be stored: cleartext in decrypt-only, sealed in
   *  encrypt. A value that is already sealed is stored as it is. */
  seal(plain: string | null | undefined): Promise<string | null>;
}

/** `F` is the app's own union of `table.column` names, used only in errors. */
export function tokenCipher<F extends string = string>(opts: TokenCipherOptions): TokenCipher<F> {
  const { kek, binding, provider, mode } = opts;
  const notKept = opts.notKept ?? 'credential was not stored';
  const support = opts.contactSupport ?? true;
  const notSent = `Nothing was sent to ${provider}${support ? '; contact support' : ''}.`;
  return {
    async open(stored, field) {
      if (stored == null) return null;
      if (!isEncryptedValue(stored)) return stored;
      let plain: string;
      try {
        plain = await decryptValue(kek, stored, field);
      } catch (err) {
        throw new TokenKeyError(
          `${field} is sealed, but this install's ${binding} is missing or does not open it (${message(err)}). ${notSent}`,
        );
      }
      // Sealed twice is a defect, and a still-sealed value must never be
      // used as a token.
      if (isEncryptedValue(plain)) throw new TokenKeyError(`${field} is sealed twice. ${notSent}`);
      return plain;
    },
    async seal(plain) {
      if (plain == null) return null;
      if (mode === 'decrypt-only' || isEncryptedValue(plain)) return plain;
      try {
        return await encryptValue(kek, plain);
      } catch (err) {
        throw new TokenKeyError(
          `this install's ${binding} is missing or unusable, so a ${provider} ${notKept} (${message(err)}).${support ? ' Contact support.' : ''}`,
        );
      }
    },
  };
}

/** Whether this install has its key bound. */
export function tokenKekBound(kek: string | null | undefined): boolean {
  return typeof kek === 'string' && kek.trim() !== '';
}

/**
 * The first candidate that opens to a non-empty token, for a provider revoke
 * on disconnect or uninstall: typically `[[row.refresh_token, '...refresh_token'],
 * [row.access_token, '...access_token']]`. A sealed candidate this install
 * cannot open gives null and calls `onUnopenable` with the error message (it
 * names the field, never a token), so the caller skips the revoke and still
 * deletes its row; the person can revoke the grant at the provider.
 */
export async function revocableToken<F extends string>(
  cipher: TokenCipher<F>,
  candidates: ReadonlyArray<readonly [string | null | undefined, F]>,
  onUnopenable: (message: string) => void,
): Promise<string | null> {
  try {
    for (const [stored, field] of candidates) {
      const plain = await cipher.open(stored, field);
      if (plain) return plain;
    }
    return null;
  } catch (err) {
    onUnopenable(message(err));
    return null;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
