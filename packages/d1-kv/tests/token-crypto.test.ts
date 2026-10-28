/**
 * The envelope as the package exports it (0.2.2): `encryptValue` and
 * `decryptValue` from the index, for credential material outside a
 * key/value table. These pin the public surface, and that a value sealed
 * here and one the token store sealed are interchangeable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENVELOPE_PREFIX,
  decryptValue,
  encryptValue,
  isEncryptedValue,
  makeD1TokenStore,
} from '../src/index';
import { __resetDerivedKeyCacheForTests } from '../src/token-crypto';
import { makeMockD1 } from './mock-d1';

/** A KEK shaped like what the platform mints for an `auto_generate` secret. */
const KEK = btoa('0123456789abcdef0123456789abcdef');
const OTHER_KEK = btoa('fedcba9876543210fedcba9876543210');
const TOKEN = '1//0g-refresh-token-value';

beforeEach(() => {
  __resetDerivedKeyCacheForTests();
});

describe('encryptValue / decryptValue (exported envelope)', () => {
  it('round-trips, and the sealed form carries the envelope and not the value', async () => {
    const sealed = await encryptValue(KEK, TOKEN);

    expect(sealed.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(isEncryptedValue(sealed)).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(await decryptValue(KEK, sealed, 'users.refresh_token')).toBe(TOKEN);
  });

  it('seals the same value differently each time (a fresh IV per value)', async () => {
    const a = await encryptValue(KEK, TOKEN);
    const b = await encryptValue(KEK, TOKEN);

    expect(a).not.toBe(b);
    expect(await decryptValue(KEK, a, 'users.refresh_token')).toBe(TOKEN);
    expect(await decryptValue(KEK, b, 'users.refresh_token')).toBe(TOKEN);
  });

  it('hands back a value without the envelope unchanged, with no key at all', async () => {
    expect(await decryptValue(undefined, TOKEN, 'users.refresh_token')).toBe(TOKEN);
    expect(await decryptValue('', TOKEN, 'users.refresh_token')).toBe(TOKEN);
  });

  it('refuses to seal without a usable key', async () => {
    await expect(encryptValue(undefined, TOKEN)).rejects.toThrow(/no key-encryption key/);
    await expect(encryptValue('   ', TOKEN)).rejects.toThrow(/no key-encryption key/);
    await expect(encryptValue(btoa('short'), TOKEN)).rejects.toThrow(/at least 16 are required/);
  });

  it('a sealed value with a missing key throws, naming the label and not the value', async () => {
    const sealed = await encryptValue(KEK, TOKEN);

    const err = await decryptValue(undefined, sealed, 'users.refresh_token').catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/no key-encryption key/);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain(sealed);
  });

  it('a wrong key or an altered value throws, naming the label and not the value', async () => {
    const sealed = await encryptValue(KEK, TOKEN);
    const altered = `${sealed.slice(0, -4)}AAAA`;

    for (const [kek, stored] of [
      [OTHER_KEK, sealed],
      [KEK, altered],
    ] as const) {
      const err = await decryptValue(kek, stored, 'users.refresh_token').catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('could not decrypt users.refresh_token');
      expect((err as Error).message).not.toContain(TOKEN);
      expect((err as Error).message).not.toContain(stored);
    }
  });

  it('a malformed envelope throws without echoing it', async () => {
    const stored = `${ENVELOPE_PREFIX}not-an-envelope`;

    const err = await decryptValue(KEK, stored, 'users.refresh_token').catch((e: Error) => e);

    expect((err as Error).message).toBe('d1-kv: users.refresh_token carries a malformed encryption envelope.');
  });

  it('is interchangeable with the token store: each opens what the other sealed', async () => {
    const db = makeMockD1({ acme_secrets: {} });
    const store = makeD1TokenStore({ db, table: 'acme_secrets', encryption: { mode: 'encrypt', kek: KEK } });

    await store.put('refresh_token', TOKEN);
    const byStore = await db
      .prepare('SELECT value FROM acme_secrets WHERE key = ?')
      .bind('refresh_token')
      .first<{ value: string }>();
    expect(isEncryptedValue(byStore!.value)).toBe(true);
    expect(await decryptValue(KEK, byStore!.value, 'acme_secrets.refresh_token')).toBe(TOKEN);

    const sealedHere = await encryptValue(KEK, 'access-token-value');
    const seeded = makeMockD1({ acme_secrets: { access_token: sealedHere } });
    const reader = makeD1TokenStore({ db: seeded, table: 'acme_secrets', encryption: { mode: 'encrypt', kek: KEK } });
    expect(await reader.get('access_token')).toBe('access-token-value');
  });
});
