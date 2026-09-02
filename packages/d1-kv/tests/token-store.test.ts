import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeD1TokenStore } from '../src/token-store';
import {
  ENVELOPE_PREFIX,
  isEncryptedValue,
  __resetDerivedKeyCacheForTests,
} from '../src/token-crypto';
import { makeMockD1, type DbState } from './mock-d1';

/** A KEK shaped like what the platform mints for an `auto_generate` secret. */
const KEK = btoa('0123456789abcdef0123456789abcdef');
const OTHER_KEK = btoa('fedcba9876543210fedcba9876543210');

const cleartext = { mode: 'cleartext', reason: 'unit test' } as const;

/**
 * Mock D1 plus a `raw` reader that goes through the same SQL the store uses,
 * so a test can assert on the bytes actually persisted rather than on what
 * the store hands back.
 */
function makeDb(initial: DbState = { shopify_secrets: {} }) {
  const db = makeMockD1(initial);
  const raw = async (table: string, key: string): Promise<string | undefined> => {
    const row = await db
      .prepare(`SELECT value FROM ${table} WHERE key = ?`)
      .bind(key)
      .first<{ value: string }>();
    return row?.value;
  };
  return { db, raw };
}

beforeEach(() => {
  __resetDerivedKeyCacheForTests();
});

describe('makeD1TokenStore', () => {
  it('rejects a non-identifier table name', () => {
    const db = makeMockD1();
    expect(() =>
      makeD1TokenStore({ db, table: 'foo; DROP TABLE bar', encryption: cleartext }),
    ).toThrow(/not a plain SQL identifier/);
  });

  it('get returns null for unknown key', async () => {
    const db = makeMockD1({ shopify_secrets: {} });
    const store = makeD1TokenStore({ db, table: 'shopify_secrets', encryption: cleartext });
    expect(await store.get('refresh_token')).toBeNull();
  });

  it('put then get round-trips', async () => {
    const db = makeMockD1({ shopify_secrets: {} });
    const store = makeD1TokenStore({ db, table: 'shopify_secrets', encryption: cleartext });
    await store.put('access_token', 'shpat_xyz');
    expect(await store.get('access_token')).toBe('shpat_xyz');
  });

  it('put upserts (rotation replaces value)', async () => {
    const db = makeMockD1({ shopify_secrets: { refresh_token: 'rt-old' } });
    const store = makeD1TokenStore({ db, table: 'shopify_secrets', encryption: cleartext });
    await store.put('refresh_token', 'rt-new');
    expect(await store.get('refresh_token')).toBe('rt-new');
  });

  it('delete removes the row', async () => {
    const db = makeMockD1({ shopify_secrets: { access_token: 'at' } });
    const store = makeD1TokenStore({ db, table: 'shopify_secrets', encryption: cleartext });
    if (store.delete) await store.delete('access_token');
    expect(await store.get('access_token')).toBeNull();
  });

  it('returns an object compatible with the oauth-utils TokenStore shape', () => {
    const db = makeMockD1();
    const store = makeD1TokenStore({ db, table: 'shopify_secrets', encryption: cleartext });
    // Compile-time shape assertion via duck-typing: get, put, optional delete.
    expect(typeof store.get).toBe('function');
    expect(typeof store.put).toBe('function');
    expect(typeof store.delete).toBe('function');
  });
});

describe('encryption at rest', () => {
  it('round-trips a value through AES-GCM', async () => {
    const { db } = makeDb();
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    await store.put('refresh_token', '1//0gLongLivedGoogleRefreshToken');

    expect(await store.get('refresh_token')).toBe('1//0gLongLivedGoogleRefreshToken');
  });

  it('what lands in D1 is sealed, not the plaintext', async () => {
    const { db, raw } = makeDb();
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    await store.put('refresh_token', '1//0gLongLivedGoogleRefreshToken');

    const stored = await raw('shopify_secrets', 'refresh_token') as string;
    expect(stored).not.toContain('1//0gLongLivedGoogleRefreshToken');
    expect(stored.startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(isEncryptedValue(stored)).toBe(true);
  });

  it('uses a fresh IV per write, so two writes of the same value differ', async () => {
    const { db, raw } = makeDb();
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    await store.put('a', 'same-value');
    const first = await raw('shopify_secrets', 'a') as string;
    await store.put('b', 'same-value');
    const second = await raw('shopify_secrets', 'b') as string;

    expect(first).not.toBe(second);
    expect(await store.get('a')).toBe('same-value');
    expect(await store.get('b')).toBe('same-value');
  });

  it('handles values with multi-byte characters and dots', async () => {
    const { db } = makeDb();
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    const value = 'eyJhbGciOi.J9.sig / ünïcode ✓';
    await store.put('access_token', value);
    expect(await store.get('access_token')).toBe(value);
  });
});

describe('legacy cleartext rows (the migration path)', () => {
  it('reads a pre-existing cleartext row written before encryption shipped', async () => {
    const { db } = makeDb({ shopify_secrets: { refresh_token: 'legacy-plain-token' } });
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    expect(await store.get('refresh_token')).toBe('legacy-plain-token');
  });

  it('lazily re-encrypts a legacy row it just read', async () => {
    const { db, raw } = makeDb({ shopify_secrets: { refresh_token: 'legacy-plain-token' } });
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });

    expect(await raw('shopify_secrets', 'refresh_token')).toBe('legacy-plain-token');
    await store.get('refresh_token');

    const after = await raw('shopify_secrets', 'refresh_token') as string;
    expect(isEncryptedValue(after)).toBe(true);
    expect(after).not.toContain('legacy-plain-token');
    // and it is still readable
    expect(await store.get('refresh_token')).toBe('legacy-plain-token');
  });

  it('a failed lazy re-encrypt does not fail the read', async () => {
    const { db } = makeDb({ shopify_secrets: { refresh_token: 'legacy-plain-token' } });
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.includes('INSERT INTO')) throw new Error('D1_ERROR: transient');
      return realPrepare(sql);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    expect(await store.get('refresh_token')).toBe('legacy-plain-token');
    expect(warn).toHaveBeenCalled();
    // the warning names the row, never the value
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('shopify_secrets.refresh_token');
    expect(logged).not.toContain('legacy-plain-token');
    warn.mockRestore();
  });

  it('decrypt-only mode reads sealed rows but keeps writing cleartext (rollback-safe)', async () => {
    const { db, raw } = makeDb();
    const encrypting = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    await encrypting.put('refresh_token', 'sealed-by-a-newer-build');

    const readOnly = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'decrypt-only', kek: KEK },
    });
    expect(await readOnly.get('refresh_token')).toBe('sealed-by-a-newer-build');

    await readOnly.put('access_token', 'written-in-the-clear');
    expect(await raw('shopify_secrets', 'access_token')).toBe('written-in-the-clear');
    expect(isEncryptedValue(await raw('shopify_secrets', 'access_token') as string)).toBe(false);
  });

  it('decrypt-only does not re-encrypt a legacy row', async () => {
    const { db, raw } = makeDb({ shopify_secrets: { refresh_token: 'legacy-plain-token' } });
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'decrypt-only', kek: KEK },
    });
    await store.get('refresh_token');
    expect(await raw('shopify_secrets', 'refresh_token')).toBe('legacy-plain-token');
  });
});

describe('tamper and wrong-key detection', () => {
  it('rejects a value sealed under a different KEK', async () => {
    const { db } = makeDb();
    const writer = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    await writer.put('refresh_token', 'secret-token');

    const reader = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: OTHER_KEK },
    });
    await expect(reader.get('refresh_token')).rejects.toThrow(
      /could not decrypt shopify_secrets\.refresh_token/,
    );
  });

  it('rejects a ciphertext whose bytes were altered (AES-GCM auth tag)', async () => {
    const { db, raw } = makeDb();
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    await store.put('refresh_token', 'secret-token');

    // Flip one base64 character of the ciphertext half, in place.
    const sealed = await raw('shopify_secrets', 'refresh_token') as string;
    const body = sealed.slice(ENVELOPE_PREFIX.length);
    const dot = body.indexOf('.');
    const ct = body.slice(dot + 1);
    const flipped = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    const tampered = `${ENVELOPE_PREFIX}${body.slice(0, dot)}.${flipped}`;
    await makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: cleartext,
    }).put('refresh_token', tampered);

    await expect(store.get('refresh_token')).rejects.toThrow(/could not decrypt/);
  });

  it('a decrypt failure never echoes the ciphertext or the key', async () => {
    const { db } = makeDb();
    await makeD1TokenStore({ db, table: 'shopify_secrets', encryption: cleartext }).put(
      'refresh_token',
      `${ENVELOPE_PREFIX}${btoa('aaaaaaaaaaaa')}.${btoa('not-real-ciphertext-bytes')}`,
    );
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });

    const err = await store.get('refresh_token').then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(KEK);
    expect(err!.message).not.toContain(btoa('not-real-ciphertext-bytes'));
    expect(err!.message).toContain('shopify_secrets.refresh_token');
  });

  it('rejects a malformed envelope without attempting a decrypt', async () => {
    const { db } = makeDb({ shopify_secrets: { refresh_token: `${ENVELOPE_PREFIX}nodothere` } });
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    });
    await expect(store.get('refresh_token')).rejects.toThrow(/malformed encryption envelope/);
  });

  it('a cleartext-mode store refuses to hand back a sealed value as if it were a token', async () => {
    const { db } = makeDb();
    await makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: KEK },
    }).put('refresh_token', 'secret-token');

    const store = makeD1TokenStore({ db, table: 'shopify_secrets', encryption: cleartext });
    await expect(store.get('refresh_token')).rejects.toThrow(
      /is encrypted but this store is configured mode "cleartext"/,
    );
  });
});

describe('missing or unusable KEK', () => {
  it('throws at construction when the KEK is undefined, and writes nothing', async () => {
    const { db, raw } = makeDb();
    expect(() =>
      makeD1TokenStore({
        db,
        table: 'shopify_secrets',
        encryption: { mode: 'encrypt', kek: undefined },
      }),
    ).toThrow(/needs a key-encryption key for mode "encrypt"/);
    expect(await raw('shopify_secrets', 'refresh_token')).toBeUndefined();
  });

  it('throws at construction when the KEK is an empty or blank string', () => {
    const { db } = makeDb();
    for (const kek of ['', '   ']) {
      expect(() =>
        makeD1TokenStore({ db, table: 'shopify_secrets', encryption: { mode: 'encrypt', kek } }),
      ).toThrow(/needs a key-encryption key/);
    }
  });

  it('the missing-KEK error does not silently degrade to a cleartext write', async () => {
    const { db, raw } = makeDb();
    let store: ReturnType<typeof makeD1TokenStore> | null = null;
    try {
      store = makeD1TokenStore({
        db,
        table: 'shopify_secrets',
        encryption: { mode: 'encrypt', kek: undefined },
      });
    } catch {
      /* expected */
    }
    expect(store).toBeNull();
    // nothing usable exists, so nothing can have written a plaintext token
    expect(await raw('shopify_secrets', 'refresh_token')).toBeUndefined();
  });

  it('throws when the KEK decodes to too few bytes', async () => {
    const { db } = makeDb();
    const store = makeD1TokenStore({
      db,
      table: 'shopify_secrets',
      encryption: { mode: 'encrypt', kek: 'short' },
    });
    await expect(store.put('refresh_token', 'x')).rejects.toThrow(/at least 16 are required/);
  });

  it('cleartext mode demands a written reason', () => {
    const { db } = makeDb();
    expect(() =>
      makeD1TokenStore({
        db,
        table: 'shopify_secrets',
        encryption: { mode: 'cleartext', reason: '' },
      }),
    ).toThrow(/no reason/);
  });
});
