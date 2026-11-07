/**
 * sprigr-team#13941: an encrypt-mode store re-seals a legacy cleartext row
 * only when `get` reads it, so a row that is never read stays cleartext in
 * the install's D1. `sealLegacyRows` seals them in bounded batches.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeD1TokenStore } from '../src/token-store';
import { isEncryptedValue, __resetDerivedKeyCacheForTests } from '../src/token-crypto';
import { makeMockD1, type DbState } from './mock-d1';

const KEK = btoa('0123456789abcdef0123456789abcdef');
const T = 'shopify_secrets';

function setup(initial: DbState) {
  const db = makeMockD1(initial);
  const raw = async (key: string) =>
    (await db.prepare(`SELECT value FROM ${T} WHERE key = ?`).bind(key).first<{ value: string }>())?.value;
  const store = makeD1TokenStore({ db, table: T, encryption: { mode: 'encrypt', kek: KEK } });
  return { db, raw, store };
}

beforeEach(() => {
  __resetDerivedKeyCacheForTests();
});

describe('sealLegacyRows (sprigr-team#13941)', () => {
  it('seals cleartext rows that were never read, and they still read back', async () => {
    const { raw, store } = setup({ [T]: { refresh_token: 'legacy-refresh', client_secret: 'legacy-secret' } });

    expect(await store.sealLegacyRows()).toEqual({ sealed: 2, remaining: false });

    for (const [k, v] of [['refresh_token', 'legacy-refresh'], ['client_secret', 'legacy-secret']] as const) {
      const stored = (await raw(k)) as string;
      expect(isEncryptedValue(stored)).toBe(true);
      expect(stored).not.toContain(v);
      expect(await store.get(k)).toBe(v);
    }
  });

  it('leaves already-sealed rows untouched', async () => {
    const { raw, store } = setup({ [T]: {} });
    await store.put('refresh_token', 'fresh-token');
    const before = await raw('refresh_token');

    expect(await store.sealLegacyRows()).toEqual({ sealed: 0, remaining: false });
    expect(await raw('refresh_token')).toBe(before);
  });

  it('seals at most `limit` rows per call and says more remain', async () => {
    const rows = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, `plain-${i}`]));
    const { raw, store } = setup({ [T]: rows });

    expect(await store.sealLegacyRows({ limit: 2 })).toEqual({ sealed: 2, remaining: true });
    const sealedNow = (await Promise.all(Object.keys(rows).map(raw))).filter((v) => isEncryptedValue(v as string));
    expect(sealedNow).toHaveLength(2);

    expect(await store.sealLegacyRows({ limit: 2 })).toEqual({ sealed: 2, remaining: true });
    expect(await store.sealLegacyRows({ limit: 2 })).toEqual({ sealed: 1, remaining: false });
  });

  it('a put that lands between the scan and the seal wins', async () => {
    const { db, raw } = setup({ [T]: { refresh_token: 'legacy-refresh' } });
    const realPrepare = db.prepare.bind(db);
    let rotated = false;
    db.prepare = (sql: string) => {
      if (!rotated && sql.startsWith('UPDATE')) {
        rotated = true;
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              const rotator = makeD1TokenStore({ db: { prepare: realPrepare }, table: T, encryption: { mode: 'encrypt', kek: KEK } });
              await rotator.put('refresh_token', 'rotated-token');
              return realPrepare(sql).bind(...args).run();
            },
          }),
        } as unknown as ReturnType<typeof realPrepare>;
      }
      return realPrepare(sql);
    };
    const store = makeD1TokenStore({ db, table: T, encryption: { mode: 'encrypt', kek: KEK } });

    expect(await store.sealLegacyRows()).toEqual({ sealed: 0, remaining: false });
    db.prepare = realPrepare;
    expect(isEncryptedValue((await raw('refresh_token')) as string)).toBe(true);
    expect(await store.get('refresh_token')).toBe('rotated-token');
  });

  it('refuses in decrypt-only and cleartext modes, and writes nothing', async () => {
    for (const encryption of [
      { mode: 'decrypt-only', kek: KEK },
      { mode: 'cleartext', reason: 'unit test' },
    ] as const) {
      const db = makeMockD1({ [T]: { refresh_token: 'legacy-refresh' } });
      const store = makeD1TokenStore({ db, table: T, encryption });
      await expect(store.sealLegacyRows()).rejects.toThrow(/encrypt/);
      expect((await db.prepare(`SELECT value FROM ${T} WHERE key = ?`).bind('refresh_token').first<{ value: string }>())?.value).toBe('legacy-refresh');
    }
  });

  it('never returns or logs a value', async () => {
    const { store } = setup({ [T]: { refresh_token: 'legacy-refresh' } });
    const out = JSON.stringify(await store.sealLegacyRows());
    expect(out).not.toContain('legacy-refresh');
    expect(Object.keys(JSON.parse(out)).sort()).toEqual(['remaining', 'sealed']);
  });
});
