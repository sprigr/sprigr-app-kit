import { describe, expect, it } from 'vitest';
import { makeSyncState } from '../src/sync-state';
import { makeMockD1 } from './mock-d1';

describe('makeSyncState', () => {
  it('rejects a non-identifier table name', () => {
    const { db } = makeMockD1();
    expect(() => makeSyncState({ db, table: 'foo; DROP' })).toThrow(
      /not a plain SQL identifier/,
    );
  });

  it('read returns null when nothing has been written', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    expect(await state.read('orders')).toBeNull();
  });

  it('write then read round-trips cursor + scope', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', 'shop-1', 'cursor-A');
    const row = await state.read('orders', 'shop-1');
    expect(row).not.toBeNull();
    expect(row!.cursor).toBe('cursor-A');
    expect(row!.scope).toBe('shop-1');
    expect(row!.resource).toBe('orders');
  });

  it('write upserts (replaces cursor)', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', 'shop-1', 'cursor-A');
    await state.write('orders', 'shop-1', 'cursor-B');
    expect((await state.read('orders', 'shop-1'))!.cursor).toBe('cursor-B');
  });

  it('write null cursor (caught-up marker)', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', 'shop-1', null);
    expect((await state.read('orders', 'shop-1'))!.cursor).toBeNull();
  });

  it('different scopes do not collide', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', 'shop-1', 'cursor-A');
    await state.write('orders', 'shop-2', 'cursor-B');
    expect((await state.read('orders', 'shop-1'))!.cursor).toBe('cursor-A');
    expect((await state.read('orders', 'shop-2'))!.cursor).toBe('cursor-B');
  });

  it('different resources do not collide', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', 'shop-1', 'cursor-O');
    await state.write('products', 'shop-1', 'cursor-P');
    expect((await state.read('orders', 'shop-1'))!.cursor).toBe('cursor-O');
    expect((await state.read('products', 'shop-1'))!.cursor).toBe('cursor-P');
  });

  it('scope defaults to empty string when undefined', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', undefined, 'cursor-A');
    const row = await state.read('orders');
    expect(row).not.toBeNull();
    expect(row!.scope).toBe('');
  });

  it('clear removes the row', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', 'shop-1', 'cursor-A');
    await state.clear('orders', 'shop-1');
    expect(await state.read('orders', 'shop-1')).toBeNull();
  });

  it('list returns every row sorted by (resource, scope)', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('products', 'shop-2', 'p2');
    await state.write('orders', 'shop-1', 'o1');
    await state.write('products', 'shop-1', 'p1');
    const all = await state.list();
    expect(all.map((r) => `${r.resource}/${r.scope}`)).toEqual([
      'orders/shop-1',
      'products/shop-1',
      'products/shop-2',
    ]);
  });
});
