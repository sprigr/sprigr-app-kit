import { describe, expect, it } from 'vitest';
import { makeSettingsStore } from '../src/settings-store';
import { makeMockD1 } from './mock-d1';

describe('makeSettingsStore', () => {
  it('rejects a non-identifier table name', () => {
    const db = makeMockD1();
    expect(() => makeSettingsStore({ db, table: 'foo; DROP TABLE bar' })).toThrow(
      /not a plain SQL identifier/,
    );
    expect(() => makeSettingsStore({ db, table: '1leading_digit' })).toThrow();
    expect(() => makeSettingsStore({ db, table: '' })).toThrow();
  });

  it('accepts a plain identifier (alpha + underscore + digits)', () => {
    const db = makeMockD1();
    expect(() => makeSettingsStore({ db, table: 'shopify_settings' })).not.toThrow();
    expect(() => makeSettingsStore({ db, table: '_internal_2' })).not.toThrow();
  });

  it('get returns the stored value', async () => {
    const db = makeMockD1({ shopify_settings: { foo: 'bar' } });
    const store = makeSettingsStore({ db, table: 'shopify_settings' });
    expect(await store.get('foo')).toBe('bar');
  });

  it('get returns null for an unknown key', async () => {
    const db = makeMockD1({ shopify_settings: {} });
    const store = makeSettingsStore({ db, table: 'shopify_settings' });
    expect(await store.get('missing')).toBeNull();
  });

  it('set inserts a new row', async () => {
    const db = makeMockD1({ shopify_settings: {} });
    const store = makeSettingsStore({ db, table: 'shopify_settings' });
    await store.set('a', '1');
    expect(await store.get('a')).toBe('1');
  });

  it('set upserts an existing row (replaces value)', async () => {
    const db = makeMockD1({ shopify_settings: { a: 'old' } });
    const store = makeSettingsStore({ db, table: 'shopify_settings' });
    await store.set('a', 'new');
    expect(await store.get('a')).toBe('new');
  });

  it('delete removes the row', async () => {
    const db = makeMockD1({ shopify_settings: { a: '1', b: '2' } });
    const store = makeSettingsStore({ db, table: 'shopify_settings' });
    await store.delete('a');
    expect(await store.get('a')).toBeNull();
    expect(await store.get('b')).toBe('2');
  });

  it('getAll returns every row as a Record', async () => {
    const db = makeMockD1({ shopify_settings: { a: '1', b: '2', c: '3' } });
    const store = makeSettingsStore({ db, table: 'shopify_settings' });
    expect(await store.getAll()).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('getAll returns {} on an empty table', async () => {
    const db = makeMockD1({ shopify_settings: {} });
    const store = makeSettingsStore({ db, table: 'shopify_settings' });
    expect(await store.getAll()).toEqual({});
  });

  it('scopes per table (two stores against same db do not collide)', async () => {
    const db = makeMockD1({ shopify_settings: { x: '1' }, procore_settings: { x: '2' } });
    const sho = makeSettingsStore({ db, table: 'shopify_settings' });
    const pro = makeSettingsStore({ db, table: 'procore_settings' });
    expect(await sho.get('x')).toBe('1');
    expect(await pro.get('x')).toBe('2');
  });
});
