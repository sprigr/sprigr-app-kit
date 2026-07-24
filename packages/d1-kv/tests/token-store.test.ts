import { describe, expect, it } from 'vitest';
import { makeD1TokenStore } from '../src/token-store';
import { makeMockD1 } from './mock-d1';

describe('makeD1TokenStore', () => {
  it('rejects a non-identifier table name', () => {
    const db = makeMockD1();
    expect(() => makeD1TokenStore({ db, table: 'foo; DROP TABLE bar' })).toThrow(
      /not a plain SQL identifier/,
    );
  });

  it('get returns null for unknown key', async () => {
    const db = makeMockD1({ shopify_secrets: {} });
    const store = makeD1TokenStore({ db, table: 'shopify_secrets' });
    expect(await store.get('refresh_token')).toBeNull();
  });

  it('put then get round-trips', async () => {
    const db = makeMockD1({ shopify_secrets: {} });
    const store = makeD1TokenStore({ db, table: 'shopify_secrets' });
    await store.put('access_token', 'shpat_xyz');
    expect(await store.get('access_token')).toBe('shpat_xyz');
  });

  it('put upserts (rotation replaces value)', async () => {
    const db = makeMockD1({ shopify_secrets: { refresh_token: 'rt-old' } });
    const store = makeD1TokenStore({ db, table: 'shopify_secrets' });
    await store.put('refresh_token', 'rt-new');
    expect(await store.get('refresh_token')).toBe('rt-new');
  });

  it('delete removes the row', async () => {
    const db = makeMockD1({ shopify_secrets: { access_token: 'at' } });
    const store = makeD1TokenStore({ db, table: 'shopify_secrets' });
    if (store.delete) await store.delete('access_token');
    expect(await store.get('access_token')).toBeNull();
  });

  it('returns an object compatible with the oauth-utils TokenStore shape', () => {
    const db = makeMockD1();
    const store = makeD1TokenStore({ db, table: 'shopify_secrets' });
    // Compile-time shape assertion via duck-typing: get, put, optional delete.
    expect(typeof store.get).toBe('function');
    expect(typeof store.put).toBe('function');
    expect(typeof store.delete).toBe('function');
  });
});
