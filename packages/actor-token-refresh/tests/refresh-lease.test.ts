/**
 * sprigr/sprigr-apps#1547: the durable, cross-invocation half of the per-actor
 * refresh guard.
 *
 * `ActorRefreshLatch` on its own is a module-scoped Map, so it sees only
 * the callers sharing its isolate. Every test below writes (or withholds)
 * the lease row DIRECTLY, which is what a sibling isolate looks like from
 * in here: same D1, different memory.
 *
 * The first describe block runs against node:sqlite rather than the fake,
 * because the whole design rests on what SQLite's `ON CONFLICT ... DO
 * UPDATE ... WHERE` reports in `changes`, and a fake would happily agree
 * with whatever spelling I typed.
 */

import { createRequire } from 'node:module';
// Loaded through Node's own require rather than a static import: vitest 2
// (vite 5) does not list `node:sqlite` as a builtin, strips the prefix and
// then fails to resolve a package called `sqlite`. Needs Node 22.5 or later.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ActorRefreshLatch,
  RefreshLeaseBusyError,
  refreshLeaseCasSql,
  refreshLeaseReleaseSql,
  type D1Like,
  type RefreshLeaseConfig,
} from '../src/index';

const TABLE = 'simpro_refresh_lease';

const DDL = `CREATE TABLE ${TABLE} (
  actor_key   TEXT PRIMARY KEY,
  claimed_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
)`;

describe('refresh lease compare-and-swap, against a real SQLite engine', () => {
  it('inserts, refuses a LIVE lease, and takes over an EXPIRED one', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(DDL);
    const cas = db.prepare(refreshLeaseCasSql(TABLE));
    const read = db.prepare(`SELECT expires_at FROM ${TABLE} WHERE actor_key = ?`);

    // Fresh insert: acquired.
    expect(cas.run('u:one', 1_000, 31_000).changes).toBe(1);
    // A live lease is held: refused, and the holder's expiry is untouched
    // (a losing caller must not extend the winner's lease).
    expect(cas.run('u:one', 2_000, 32_000).changes).toBe(0);
    expect(read.get('u:one')).toEqual({ expires_at: 31_000 });
    // The lease has expired: taken over, and the DO UPDATE branch reports it.
    expect(cas.run('u:one', 40_000, 70_000).changes).toBe(1);
    expect(read.get('u:one')).toEqual({ expires_at: 70_000 });

    db.close();
  });

  it('NEGATIVE CONTROL: the ON CONFLICT DO NOTHING spelling never takes over an expired lease', () => {
    // This is why the lease cannot reuse @sprigr/apps-dedup-latch's
    // tryClaim. DO NOTHING is correct for a dedup latch (a duplicate is a
    // duplicate forever, until a sweep) and fatal for a lease: the
    // consuming apps declare no sweep for this table, so the first refresh
    // would take the row and NO actor would ever refresh again. If this
    // test ever starts reporting 1, the CAS above has been rewritten into
    // the wrong statement and the takeover path is dead.
    const db = new DatabaseSync(':memory:');
    db.exec(DDL);
    const doNothing = db.prepare(
      `INSERT INTO ${TABLE} (actor_key, claimed_at, expires_at)
         VALUES (?1, ?2, ?3)
       ON CONFLICT(actor_key) DO NOTHING`,
    );

    expect(doNothing.run('u:one', 1_000, 31_000).changes).toBe(1);
    // Long expired, and still refused.
    expect(doNothing.run('u:one', 999_000, 1_029_000).changes).toBe(0);
    expect(
      db.prepare(`SELECT expires_at FROM ${TABLE} WHERE actor_key = ?`).get('u:one'),
    ).toEqual({ expires_at: 31_000 });

    db.close();
  });

  it('keys per actor, so two actors never serialize against each other', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(DDL);
    const cas = db.prepare(refreshLeaseCasSql(TABLE));

    expect(cas.run('u:one', 1_000, 31_000).changes).toBe(1);
    expect(cas.run('u:two', 1_000, 31_000).changes).toBe(1);
    expect(cas.run('u:one', 2_000, 32_000).changes).toBe(0);
    // Actor two's own lease is unaffected by actor one's contention.
    expect(cas.run('u:two', 40_000, 70_000).changes).toBe(1);

    db.close();
  });

  it('the release DELETE frees the row for an immediate re-acquire', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(DDL);
    const cas = db.prepare(refreshLeaseCasSql(TABLE));
    const release = db.prepare(refreshLeaseReleaseSql(TABLE));

    expect(cas.run('u:one', 1_000, 31_000).changes).toBe(1);
    expect(cas.run('u:one', 2_000, 32_000).changes).toBe(0);
    expect(release.run('u:one').changes).toBe(1);
    // Released, so the very next caller wins without waiting out the TTL.
    expect(cas.run('u:one', 2_000, 32_000).changes).toBe(1);

    db.close();
  });

  it('refuses a table name that is not a plain SQL identifier', () => {
    expect(() => refreshLeaseCasSql('lease; DROP TABLE users')).toThrow(
      /not a plain SQL identifier/,
    );
    expect(() => refreshLeaseReleaseSql('"quoted"')).toThrow(/not a plain SQL identifier/);
  });
});

/**
 * A D1-like over a real SQLite database, so the latch tests below run the
 * genuine statements rather than regex-routed fakes.
 */
function sqliteD1(opts: { failAcquire?: boolean; failRelease?: boolean } = {}): {
  db: D1Like;
  raw: DatabaseSync;
  ops: string[];
} {
  const raw = new DatabaseSync(':memory:');
  raw.exec(DDL);
  const ops: string[] = [];
  const db: D1Like = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const isAcquire = /INSERT INTO \w+ \(actor_key/.test(sql);
      const isRelease = /^\s*DELETE FROM \w+ WHERE actor_key/.test(sql);
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T = unknown>(): Promise<T | null> {
          return (raw.prepare(sql).get(...(bound as never[])) ?? null) as T | null;
        },
        async run(): Promise<unknown> {
          ops.push(isAcquire ? 'lease:acquire' : isRelease ? 'lease:release' : 'other');
          if (isAcquire && opts.failAcquire) throw new Error('D1_ERROR: no such table');
          if (isRelease && opts.failRelease) throw new Error('D1_ERROR: unavailable');
          const res = raw.prepare(sql).run(...(bound as never[]));
          return { meta: { changes: Number(res.changes) } };
        },
      };
      return stmt;
    },
  };
  return { db, raw, ops };
}

/** A lease row a sibling isolate is holding right now. */
function holdLease(raw: DatabaseSync, actorKey: string, ttlMs = 30_000): void {
  raw
    .prepare(`INSERT OR REPLACE INTO ${TABLE} (actor_key, claimed_at, expires_at) VALUES (?, ?, ?)`)
    .run(actorKey, Date.now(), Date.now() + ttlMs);
}

/** A lease row left behind by a winner that died mid-redeem. */
function expiredLease(raw: DatabaseSync, actorKey: string): void {
  raw
    .prepare(`INSERT OR REPLACE INTO ${TABLE} (actor_key, claimed_at, expires_at) VALUES (?, ?, ?)`)
    .run(actorKey, Date.now() - 90_000, Date.now() - 60_000);
}

function leaseRowCount(raw: DatabaseSync): number {
  const row = raw.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get() as { n: number };
  return Number(row.n);
}

describe('ActorRefreshLatch with a durable lease', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  function cfgFor(
    db: D1Like,
    cached: () => Promise<string | null>,
    extra: Partial<RefreshLeaseConfig<string>> = {},
  ): RefreshLeaseConfig<string> {
    return { db, table: TABLE, cachedToken: cached, waitMs: 60, ...extra };
  }

  it('the winner redeems and releases, leaving no row behind', async () => {
    const { db, raw, ops } = sqliteD1();
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi.fn(async () => 'fresh');

    await expect(
      latch.run('u:one', refresh, cfgFor(db, async () => null)),
    ).resolves.toBe('fresh');

    expect(refresh).toHaveBeenCalledTimes(1);
    // Release lands strictly AFTER the refresh callback resolves: the apps
    // persist the rotated refresh token inside it, and releasing earlier
    // would let a second invocation spend a token this one already used.
    expect(ops).toEqual(['lease:acquire', 'lease:release']);
    expect(leaseRowCount(raw)).toBe(0);
    raw.close();
  });

  it('a caller that loses the lease returns the cached token and never calls refresh', async () => {
    const { db, raw } = sqliteD1();
    holdLease(raw, 'u:one');
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi.fn(async () => 'should-not-happen');
    const cached = vi.fn(async () => 'cached-and-valid');
    // The loser's only way to spend dispatch budget is the bounded wait,
    // which is a setTimeout. Spying on it is deterministic where a
    // wall-clock bound is not: a loaded CI host turned a zero-wait path
    // into 67ms and failed a `< 50` assertion for a PR that never touched
    // this package.
    const timers = vi.spyOn(globalThis, 'setTimeout');

    const token = await latch.run('u:one', refresh, cfgFor(db, cached));

    expect(token).toBe('cached-and-valid');
    expect(refresh).not.toHaveBeenCalled();
    // The common loser path spends none of the dispatch budget waiting:
    // one immediate store read, no timer, no second read.
    expect(cached).toHaveBeenCalledTimes(1);
    expect(timers).not.toHaveBeenCalled();
    raw.close();
  });

  it('acquires an EXPIRED lease left behind by a winner that died mid-redeem', async () => {
    const { db, raw } = sqliteD1();
    expiredLease(raw, 'u:one');
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi.fn(async () => 'fresh');

    await expect(latch.run('u:one', refresh, cfgFor(db, async () => null))).resolves.toBe('fresh');

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(leaseRowCount(raw)).toBe(0);
    raw.close();
  });

  it('a loser whose cached token is dead waits once, then returns the winner\'s token', async () => {
    const { db, raw } = sqliteD1();
    holdLease(raw, 'u:one');
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi.fn(async () => 'should-not-happen');
    let winnerPersisted = false;
    const timer = setTimeout(() => {
      winnerPersisted = true;
    }, 20);

    const started = Date.now();
    const token = await latch.run('u:one', refresh, {
      db,
      table: TABLE,
      waitMs: 60,
      cachedToken: async () => (winnerPersisted ? 'winner-token' : null),
    });
    clearTimeout(timer);

    expect(token).toBe('winner-token');
    expect(refresh).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeGreaterThanOrEqual(50); // one wait, not zero
    expect(Date.now() - started).toBeLessThan(2000); // and only one
    raw.close();
  });

  it('throws RefreshLeaseBusyError when the wait expires with nothing usable', async () => {
    const { db, raw } = sqliteD1();
    holdLease(raw, 'u:one');
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi.fn(async () => 'should-not-happen');

    await expect(
      latch.run('u:one', refresh, cfgFor(db, async () => null)),
    ).rejects.toBeInstanceOf(RefreshLeaseBusyError);
    expect(refresh).not.toHaveBeenCalled();
    raw.close();
  });

  it('fires the contention hook exactly once per losing caller, and survives it throwing', async () => {
    const { db, raw } = sqliteD1();
    holdLease(raw, 'u:one');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const latch = new ActorRefreshLatch<string>();
    const onContended = vi.fn(async () => {
      throw new Error('audit write failed');
    });

    await expect(
      latch.run('u:one', vi.fn(async () => 'x'), cfgFor(db, async () => 'cached', { onContended })),
    ).resolves.toBe('cached');

    expect(onContended).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('contention hook failed'));
    raw.close();
  });

  it('FAILS OPEN: refreshes anyway when acquiring the lease throws', async () => {
    const { db, raw } = sqliteD1({ failAcquire: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi.fn(async () => 'fresh');

    // An install that has not applied the lease migration yet, or a D1
    // blip, must not break the tenant's connection.
    await expect(latch.run('u:one', refresh, cfgFor(db, async () => null))).resolves.toBe('fresh');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refresh lease acquire failed'));
    raw.close();
  });

  it('still returns the token when releasing the lease throws', async () => {
    const { db, raw } = sqliteD1({ failRelease: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const latch = new ActorRefreshLatch<string>();

    await expect(
      latch.run('u:one', vi.fn(async () => 'fresh'), cfgFor(db, async () => null)),
    ).resolves.toBe('fresh');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refresh lease release failed'));
    raw.close();
  });

  it('releases the lease even when the refresh itself throws', async () => {
    const { db, raw, ops } = sqliteD1();
    const latch = new ActorRefreshLatch<string>();

    await expect(
      latch.run(
        'u:one',
        vi.fn(async () => {
          throw new Error('provider down');
        }),
        cfgFor(db, async () => null),
      ),
    ).rejects.toThrow('provider down');

    // A failed redeem must not strand the actor for a whole TTL.
    expect(ops).toEqual(['lease:acquire', 'lease:release']);
    expect(leaseRowCount(raw)).toBe(0);
    raw.close();
  });

  it('the in-isolate latch still coalesces, so only ONE caller per isolate touches D1', async () => {
    const { db, raw, ops } = sqliteD1();
    const latch = new ActorRefreshLatch<string>();
    // Deferred built up front, not inside the callback: with a lease the
    // callback runs AFTER the acquire await, while the in-flight map entry
    // is still set synchronously, which is exactly what makes the second
    // caller join rather than start its own acquire.
    let resolveRefresh!: (v: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveRefresh = resolve;
    });
    const refresh = vi.fn(() => pending);

    const first = latch.run('u:one', refresh, cfgFor(db, async () => null));
    const second = latch.run('u:one', refresh, cfgFor(db, async () => null));

    resolveRefresh('fresh');
    await expect(first).resolves.toBe('fresh');
    await expect(second).resolves.toBe('fresh');
    expect(refresh).toHaveBeenCalledTimes(1);
    // One acquire, not two: the durable layer is BEHIND the in-isolate one.
    expect(ops).toEqual(['lease:acquire', 'lease:release']);
    raw.close();
  });

  it('FAILS OPEN when the binding reports no meta.changes at all', async () => {
    // Absent is not zero. Zero is an atomic "somebody else holds it";
    // absent means the driver said nothing, and guessing "lost" there
    // would mean NOBODY ever holds the lease, so nobody ever redeems, and
    // every actor's refresh token ages out. That is worse than having no
    // lease at all, which is why this direction is the safe one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const silent: D1Like = {
      prepare() {
        const stmt = {
          bind: () => stmt,
          async first<T>() {
            return null as T | null;
          },
          async run() {
            return { success: true }; // no meta at all
          },
        };
        return stmt;
      },
    };
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi.fn(async () => 'fresh');

    await expect(
      latch.run('u:one', refresh, {
        db: silent,
        table: TABLE,
        cachedToken: async () => 'should-not-be-used',
      }),
    ).resolves.toBe('fresh');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no meta.changes'));
  });

  it('without a lease config, run() touches no database at all', async () => {
    const { db, raw, ops } = sqliteD1();
    const latch = new ActorRefreshLatch<string>();
    const refresh = vi.fn(async () => 'fresh');

    // The no-op guarantee consumers that never adopted the lease rely on:
    // behaviour is byte-for-byte what it was before this layer existed.
    await expect(latch.run('u:one', refresh)).resolves.toBe('fresh');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(ops).toEqual([]);
    expect(leaseRowCount(raw)).toBe(0);
    void db;
    raw.close();
  });
});
