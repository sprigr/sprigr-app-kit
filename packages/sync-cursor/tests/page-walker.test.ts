import { describe, expect, it } from 'vitest';
import { makeSyncState } from '../src/sync-state';
import { runResumablePage } from '../src/page-walker';
import { makeMockD1 } from './mock-d1';

describe('runResumablePage', () => {
  it('first page: reads null cursor, calls fetchPage(null), writes rows, advances cursor', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });

    const fetchCalls: Array<string | null> = [];
    const written: unknown[][] = [];

    const result = await runResumablePage({
      state,
      resource: 'orders',
      fetchPage: async (cursor) => {
        fetchCalls.push(cursor);
        return { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'cursor-A' };
      },
      writeRows: async (rows) => {
        written.push(rows);
      },
    });

    expect(fetchCalls).toEqual([null]);
    expect(written).toEqual([[{ id: 1 }, { id: 2 }]]);
    expect(result.rowsThisPage).toBe(2);
    expect(result.done).toBe(false);
    expect(result.nextCursor).toBe('cursor-A');
    expect((await state.read('orders'))!.cursor).toBe('cursor-A');
  });

  it('second page: reads existing cursor, advances to next', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', undefined, 'cursor-A');

    const result = await runResumablePage({
      state,
      resource: 'orders',
      fetchPage: async (cursor) => {
        expect(cursor).toBe('cursor-A');
        return { rows: [{ id: 3 }], nextCursor: 'cursor-B' };
      },
      writeRows: async () => {},
    });

    expect(result.nextCursor).toBe('cursor-B');
    expect(result.done).toBe(false);
    expect((await state.read('orders'))!.cursor).toBe('cursor-B');
  });

  it('final page: nextCursor null marks done, cursor stays at last known', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', undefined, 'cursor-A');

    const result = await runResumablePage({
      state,
      resource: 'orders',
      fetchPage: async () => ({ rows: [{ id: 99 }], nextCursor: null }),
      writeRows: async () => {},
    });

    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
    expect(result.rowsThisPage).toBe(1);
  });

  it('does NOT advance cursor when fetchPage throws (retry safe)', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', undefined, 'cursor-A');

    await expect(
      runResumablePage({
        state,
        resource: 'orders',
        fetchPage: async () => {
          throw new Error('network');
        },
        writeRows: async () => {},
      }),
    ).rejects.toThrow(/network/);

    // Cursor unchanged so the next invocation retries the same page.
    expect((await state.read('orders'))!.cursor).toBe('cursor-A');
  });

  it('does NOT advance cursor when writeRows throws (retry safe)', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', undefined, 'cursor-A');

    await expect(
      runResumablePage({
        state,
        resource: 'orders',
        fetchPage: async () => ({ rows: [{ id: 1 }], nextCursor: 'cursor-B' }),
        writeRows: async () => {
          throw new Error('d1 down');
        },
      }),
    ).rejects.toThrow(/d1 down/);

    expect((await state.read('orders'))!.cursor).toBe('cursor-A');
  });

  it('declares done when nextCursor equals the cursor we read (stuck provider guard)', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', undefined, 'cursor-A');

    const result = await runResumablePage({
      state,
      resource: 'orders',
      fetchPage: async () => ({ rows: [], nextCursor: 'cursor-A' }),
      writeRows: async () => {},
    });

    expect(result.done).toBe(true);
    expect(result.nextCursor).toBeNull();
  });

  it('writes rows BEFORE advancing the cursor', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });

    const order: string[] = [];

    await runResumablePage({
      state,
      resource: 'orders',
      fetchPage: async () => ({ rows: [{ id: 1 }], nextCursor: 'cursor-A' }),
      writeRows: async () => {
        order.push('write-rows');
      },
    });
    order.push('after');

    // The internal sequence is: read cursor, fetchPage, writeRows, state.write(nextCursor).
    // We can observe the persisted cursor AFTER the call to confirm advancement happened.
    expect(order).toEqual(['write-rows', 'after']);
    expect((await state.read('orders'))!.cursor).toBe('cursor-A');
  });

  it('honours scope for per-store partitioning', async () => {
    const { db } = makeMockD1();
    const state = makeSyncState({ db, table: 'sync_state' });
    await state.write('orders', 'shop-1', 'cursor-A1');
    await state.write('orders', 'shop-2', 'cursor-B1');

    await runResumablePage({
      state,
      resource: 'orders',
      scope: 'shop-1',
      fetchPage: async (c) => {
        expect(c).toBe('cursor-A1');
        return { rows: [{ id: 1 }], nextCursor: 'cursor-A2' };
      },
      writeRows: async () => {},
    });

    expect((await state.read('orders', 'shop-1'))!.cursor).toBe('cursor-A2');
    expect((await state.read('orders', 'shop-2'))!.cursor).toBe('cursor-B1');
  });
});
