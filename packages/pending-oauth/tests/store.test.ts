/**
 * Unit tests for the shared pending-OAuth CSRF store.
 *
 * These pin the behaviour the ten apps relied on when each carried its
 * own hand-copied version (issue sprigr/sprigr-apps#544): single-use consume, the DELETE
 * running before the TTL check, a parse guard that returns null instead
 * of throwing, and a trim window that can be longer than the consume
 * window.
 */
import { describe, it, expect } from 'vitest';
import { makeMockD1 } from './mock-d1';
import {
  makePendingOAuthStore,
  DEFAULT_PENDING_TTL_MS,
} from '../src/store';
import type { PendingStateBase } from '../src/types';

const TABLE = 'demo_pending_oauth';

interface DemoState extends PendingStateBase {
  actorPlatformUserId: string | null;
  actorAgentId: string | null;
}

const demo = (csrf: string): DemoState => ({
  csrf,
  actorPlatformUserId: 'plat_1',
  actorAgentId: null,
  iat: Date.now(),
});

describe('makePendingOAuthStore', () => {
  it('round-trips store -> consume', async () => {
    const mock = makeMockD1();
    const store = makePendingOAuthStore<DemoState>({ db: mock.db, table: TABLE });

    const state = demo('csrf-a');
    await store.store(state);
    expect(Object.keys(mock.rows(TABLE))).toEqual(['csrf-a']);

    const got = await store.consume('csrf-a');
    expect(got).toEqual(state);
  });

  it('is single-use: a second consume of the same csrf returns null (replay)', async () => {
    const mock = makeMockD1();
    const store = makePendingOAuthStore<DemoState>({ db: mock.db, table: TABLE });

    await store.store(demo('csrf-b'));
    expect(await store.consume('csrf-b')).not.toBeNull();
    expect(await store.consume('csrf-b')).toBeNull();
    expect(mock.rows(TABLE)['csrf-b']).toBeUndefined();
  });

  it('returns null for a csrf that was never minted, and touches no row', async () => {
    const mock = makeMockD1();
    const store = makePendingOAuthStore<DemoState>({ db: mock.db, table: TABLE });

    await store.store(demo('csrf-real'));
    expect(await store.consume('csrf-forged')).toBeNull();
    // The legitimate row is untouched by the forged lookup.
    expect(mock.rows(TABLE)['csrf-real']).toBeDefined();
  });

  it('rejects an expired row AND still deletes it (delete precedes the TTL check)', async () => {
    const mock = makeMockD1();
    const store = makePendingOAuthStore<DemoState>({ db: mock.db, table: TABLE });

    await store.store(demo('csrf-old'));
    const row = mock.rows(TABLE)['csrf-old']!;
    mock.rows(TABLE)['csrf-old'] = {
      ...row,
      created_at: Date.now() - (DEFAULT_PENDING_TTL_MS + 60_000),
    };

    expect(await store.consume('csrf-old')).toBeNull();
    // This is the replay defence: an expired csrf is burned on first
    // presentation, not left behind for a second attempt.
    expect(mock.rows(TABLE)['csrf-old']).toBeUndefined();
    expect(mock.log).toContain(`DELETE FROM ${TABLE} WHERE csrf = ?`);
  });

  it('accepts a row just inside the window and rejects one just outside it', async () => {
    const mock = makeMockD1();
    const store = makePendingOAuthStore<DemoState>({ db: mock.db, table: TABLE });

    await store.store(demo('inside'));
    mock.rows(TABLE)['inside'] = {
      ...mock.rows(TABLE)['inside']!,
      created_at: Date.now() - (DEFAULT_PENDING_TTL_MS - 1_000),
    };
    expect(await store.consume('inside')).not.toBeNull();

    await store.store(demo('outside'));
    mock.rows(TABLE)['outside'] = {
      ...mock.rows(TABLE)['outside']!,
      created_at: Date.now() - (DEFAULT_PENDING_TTL_MS + 1_000),
    };
    expect(await store.consume('outside')).toBeNull();
  });

  it('returns null (no throw) when the stored payload is not valid JSON', async () => {
    const mock = makeMockD1({
      [TABLE]: { mangled: { payload: '{not json', created_at: Date.now() } },
    });
    const store = makePendingOAuthStore<DemoState>({ db: mock.db, table: TABLE });

    await expect(store.consume('mangled')).resolves.toBeNull();
    expect(mock.rows(TABLE)['mangled']).toBeUndefined();
  });

  it('honours an explicit ttlMs override on consume (admin-consent path)', async () => {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const mock = makeMockD1();
    const store = makePendingOAuthStore<DemoState>({ db: mock.db, table: TABLE });

    await store.store(demo('admin'));
    mock.rows(TABLE)['admin'] = {
      ...mock.rows(TABLE)['admin']!,
      created_at: Date.now() - 3 * 24 * 60 * 60 * 1000,
    };

    // Three days old: outside the 24h default, inside the 7d override.
    expect(await store.consume('admin', SEVEN_DAYS)).not.toBeNull();
  });

  it('rejects with the default window when no override is passed', async () => {
    const mock = makeMockD1();
    const store = makePendingOAuthStore<DemoState>({ db: mock.db, table: TABLE });

    await store.store(demo('admin2'));
    mock.rows(TABLE)['admin2'] = {
      ...mock.rows(TABLE)['admin2']!,
      created_at: Date.now() - 3 * 24 * 60 * 60 * 1000,
    };
    expect(await store.consume('admin2')).toBeNull();
  });

  it('exposes the configured default window as .ttlMs', () => {
    const mock = makeMockD1();
    expect(makePendingOAuthStore({ db: mock.db, table: TABLE }).ttlMs).toBe(
      DEFAULT_PENDING_TTL_MS,
    );
    expect(
      makePendingOAuthStore({ db: mock.db, table: TABLE, ttlMs: 60_000 }).ttlMs,
    ).toBe(60_000);
  });

  it('a custom ttlMs is enforced on consume', async () => {
    const mock = makeMockD1();
    const store = makePendingOAuthStore<DemoState>({
      db: mock.db,
      table: TABLE,
      ttlMs: 60_000,
    });
    await store.store(demo('short'));
    mock.rows(TABLE)['short'] = {
      ...mock.rows(TABLE)['short']!,
      created_at: Date.now() - 90_000,
    };
    expect(await store.consume('short')).toBeNull();
  });

  describe('trimExpired', () => {
    it('deletes only rows older than the window, leaving fresh ones', async () => {
      const now = Date.now();
      const mock = makeMockD1({
        [TABLE]: {
          fresh: { payload: '{}', created_at: now - 1_000 },
          stale: { payload: '{}', created_at: now - (DEFAULT_PENDING_TTL_MS + 1_000) },
        },
      });
      const store = makePendingOAuthStore<DemoState>({ db: mock.db, table: TABLE });

      await store.trimExpired();
      expect(Object.keys(mock.rows(TABLE))).toEqual(['fresh']);
    });

    it('uses trimTtlMs, so a longer-window row survives a shorter consume window', async () => {
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const mock = makeMockD1({
        [TABLE]: {
          // Older than the 24h consume window but inside the 7d trim
          // window: this is the microsoft-365 admin-consent row that a
          // 24h sweep would silently delete out from under the IT admin.
          adminConsent: { payload: '{}', created_at: now - 3 * 24 * 60 * 60 * 1000 },
          ancient: { payload: '{}', created_at: now - (SEVEN_DAYS + 1_000) },
        },
      });
      const store = makePendingOAuthStore<DemoState>({
        db: mock.db,
        table: TABLE,
        trimTtlMs: SEVEN_DAYS,
      });

      await store.trimExpired();
      expect(Object.keys(mock.rows(TABLE))).toEqual(['adminConsent']);
    });
  });

  describe('assertIdent', () => {
    it('rejects a table name carrying SQL', () => {
      const mock = makeMockD1();
      expect(() =>
        makePendingOAuthStore({ db: mock.db, table: 'foo; DROP TABLE bar' }),
      ).toThrow(/not a plain SQL identifier/);
    });

    it('rejects a table name with a space', () => {
      const mock = makeMockD1();
      expect(() => makePendingOAuthStore({ db: mock.db, table: 'foo bar' })).toThrow(
        /pending-oauth: table name "foo bar"/,
      );
    });

    it('rejects an empty table name', () => {
      const mock = makeMockD1();
      expect(() => makePendingOAuthStore({ db: mock.db, table: '' })).toThrow(
        /not a plain SQL identifier/,
      );
    });

    it('accepts the ten real app table names', () => {
      const mock = makeMockD1();
      for (const t of [
        'gsc_pending_oauth',
        'ga_pending_oauth',
        'xero_pending_oauth',
        'simpro_pending_oauth',
        'slack_pending_oauth',
        'gws_pending_oauth',
        'ms_pending_oauth',
        'google_ads_pending_oauth',
        'gmc_pending_oauth',
        'meta_ads_pending_oauth',
      ]) {
        expect(() => makePendingOAuthStore({ db: mock.db, table: t })).not.toThrow();
      }
    });
  });

  it('emits the table name it was given, and only that table', async () => {
    const mock = makeMockD1();
    const store = makePendingOAuthStore<DemoState>({
      db: mock.db,
      table: 'gsc_pending_oauth',
    });
    await store.store(demo('x'));
    await store.consume('x');
    await store.trimExpired();
    expect(mock.log).toEqual([
      'INSERT INTO gsc_pending_oauth (csrf, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(csrf) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at',
      'SELECT payload, created_at FROM gsc_pending_oauth WHERE csrf = ?',
      'DELETE FROM gsc_pending_oauth WHERE csrf = ?',
      'DELETE FROM gsc_pending_oauth WHERE created_at < ?',
    ]);
  });
});
