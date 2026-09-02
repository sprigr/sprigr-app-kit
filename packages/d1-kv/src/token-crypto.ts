/**
 * AES-GCM envelope for values held in a per-install D1 secrets table.
 *
 * This is the same construction `apps/email-imap-pop/src/lib/crypto.ts`
 * already uses for mailbox passwords and OAuth material, lifted so the
 * shared token store can use it too. Nothing novel is invented here: the
 * key derivation, the 96-bit per-record IV, and the base64 encoding are
 * deliberately identical to that precedent.
 *
 * Key derivation: SHA-256 of the install's KEK, giving a 256-bit AES-GCM
 * key. The KEK input may be a base64 random blob (what the platform mints
 * for an `auto_generate` secret) or a passphrase; both collapse to the
 * same shape after SHA-256.
 *
 * Envelope: `sprigr.enc.v1.<base64 iv>.<base64 ciphertext+tag>`.
 * The prefix is what lets a reader tell an encrypted value from a
 * pre-existing cleartext one without a schema change or a backfill, which
 * is the whole migration story (see token-store.ts).
 *
 * WebCrypto only. This runs on Cloudflare Workers, so there is no
 * `node:crypto` available and none is imported.
 *
 * Nothing in this module logs. A decrypt failure throws a message that
 * names the field, never the ciphertext, never the key.
 */

const AES_KEY_BITS = 256;
const IV_BYTES = 12;
const KEK_MIN_BYTES = 16;

/**
 * Envelope marker. Bumping the version means bumping this constant and
 * teaching `decryptValue` to dispatch on it; `isEncryptedValue` stays the
 * cheap "is this ours at all" test.
 */
export const ENVELOPE_PREFIX = 'sprigr.enc.v1.';

/**
 * Per-isolate derived-key cache, keyed by the raw KEK string.
 *
 * A Worker isolate handles many requests, and SHA-256 + importKey on every
 * token read is pure overhead. The cache holds a non-extractable CryptoKey,
 * so the derived key cannot be read back out of it.
 */
const derivedKeys = new Map<string, Promise<CryptoKey>>();

/** True when `value` carries our envelope and must be decrypted before use. */
export function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Derive the AES-GCM key for a KEK.
 *
 * Throws when the KEK is absent or too short. Callers surface that as a
 * startup-shaped failure: an install with no KEK must fail loudly rather
 * than quietly writing cleartext.
 */
export async function deriveKey(kek: string | undefined | null): Promise<CryptoKey> {
  if (typeof kek !== 'string' || kek.trim().length === 0) {
    throw new Error(
      'd1-kv: no key-encryption key was supplied for the token store. ' +
        'Set the install secret this app declares for it (32 random bytes, base64) ' +
        'and redeploy. The store refuses to write credentials in cleartext.',
    );
  }
  const cached = derivedKeys.get(kek);
  if (cached) return cached;

  const promise = (async () => {
    const material = decodeKekMaterial(kek);
    if (material.byteLength < KEK_MIN_BYTES) {
      throw new Error(
        `d1-kv: the key-encryption key decoded to ${material.byteLength} bytes; ` +
          `at least ${KEK_MIN_BYTES} are required. Generate one with: openssl rand -base64 32`,
      );
    }
    const digest = await crypto.subtle.digest('SHA-256', material as unknown as BufferSource);
    return crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM', length: AES_KEY_BITS },
      /* extractable */ false,
      ['encrypt', 'decrypt'],
    );
  })();

  // Cache the promise, not the resolved key, so concurrent reads share one
  // derivation. Drop it on failure so a later call with a fixed KEK retries.
  derivedKeys.set(kek, promise);
  promise.catch(() => derivedKeys.delete(kek));
  return promise;
}

/** Encrypt `plaintext` into the versioned envelope. */
export async function encryptValue(kek: string | undefined | null, plaintext: string): Promise<string> {
  const key = await deriveKey(kek);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const bytes = new TextEncoder().encode(plaintext);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    bytes as unknown as BufferSource,
  );
  return `${ENVELOPE_PREFIX}${toB64(iv)}.${toB64(new Uint8Array(sealed))}`;
}

/**
 * Decrypt a value carrying the envelope.
 *
 * `label` is used only to make the error message locatable (table.key). It
 * must never be the value itself: a thrown message can end up in an audit
 * row or a provider error body, and this repo has already been bitten by
 * raw material reaching durable columns that way.
 */
export async function decryptValue(
  kek: string | undefined | null,
  stored: string,
  label: string,
): Promise<string> {
  if (!isEncryptedValue(stored)) return stored;
  const body = stored.slice(ENVELOPE_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) {
    throw new Error(`d1-kv: ${label} carries a malformed encryption envelope.`);
  }
  const key = await deriveKey(kek);
  let ivBytes: Uint8Array;
  let ctBytes: Uint8Array;
  try {
    ivBytes = fromB64(body.slice(0, dot));
    ctBytes = fromB64(body.slice(dot + 1));
  } catch {
    throw new Error(`d1-kv: ${label} carries a malformed encryption envelope.`);
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes as unknown as BufferSource },
      key,
      ctBytes as unknown as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    // AES-GCM authentication failed: wrong KEK, or the row was altered.
    // Deliberately no ciphertext and no key material in the message.
    throw new Error(
      `d1-kv: could not decrypt ${label}. The value is AES-GCM sealed but the ` +
        'install key does not match it, or the row was modified. ' +
        'Reconnect the integration to mint fresh credentials.',
    );
  }
}

/**
 * Accept either a base64 blob (the recommended, and what `auto_generate`
 * mints) or a raw passphrase. Matches email-imap-pop's `decodeKek`.
 */
function decodeKekMaterial(raw: string): Uint8Array {
  const trimmed = raw.trim();
  try {
    const bin = atob(trimmed);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    if (out.byteLength >= KEK_MIN_BYTES) return out;
  } catch {
    /* not base64; fall through to the UTF-8 reading */
  }
  return new TextEncoder().encode(trimmed);
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Test-only: drop the per-isolate derived-key cache. */
export function __resetDerivedKeyCacheForTests(): void {
  derivedKeys.clear();
}
