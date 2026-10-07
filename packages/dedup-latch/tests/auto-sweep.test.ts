/**
 * The latch sweeps itself (0.2.0). Apps kept forgetting to schedule
 * sweep() (servicem8, gorgias, procore and xero-accounting all had to be
 * fixed one by one, sprigr-apps#2616), so a dedup table grew by one row per
 * delivery forever. tryClaim now runs a BOUNDED sweep on roughly one claim
 * in N. Real SQL in node:sqlite, because D1 has no DELETE ... LIMIT and only
 * a real engine proves the subquery form works.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { makeDedupLatch } from '../src/dedup-latch';
import type { D1Like } from '../src/types';

const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

function sqliteD1(): { db: D1Like; raw: DatabaseSync } {
  const raw = new Database(':memory:');
  raw.exec(`CREATE TABLE dedup (id TEXT PRIMARY KEY, claimed_at TEXT NOT NULL, expires_at TEXT NOT NULL);
            CREATE INDEX idx_dedup_expires ON dedup(expires_at);`);
  const db: D1Like = {
    prepare(sql: string) {
      const stmt = (args: unknown[]) => ({
        bind: (...more: unknown[]) => stmt([...args, ...more]),
        async run() {
          const info = raw.prepare(sql).run(...(args as never[]));
          return { meta: { changes: Number(info.changes) } };
        },
        async first<T>() {
          return (raw.prepare(sql).get(...(args as never[])) as T) ?? null;
        },
      });
      return stmt([]);
    },
  };
  return { db, raw };
}

function seedExpired(raw: DatabaseSync, n: number) {
  const ins = raw.prepare("INSERT INTO dedup (id, claimed_at, expires_at) VALUES (?, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')");
  for (let i = 0; i < n; i++) ins.run(`old-${i}`);
}
const count = (raw: DatabaseSync) => (raw.prepare('SELECT COUNT(*) AS n FROM dedup').get() as { n: number }).n;

describe('tryClaim sweeps on about one claim in N, in bounded batches', () => {
  it('sweeps expired rows when the draw hits, capped at the batch size', async () => {
    const { db, raw } = sqliteD1();
    seedExpired(raw, 1200);
    const latch = makeDedupLatch({ db, table: 'dedup', ttlSec: 60, autoSweep: { everyNClaims: 10, batch: 500 }, random: () => 0 });

    expect(await latch.tryClaim('new-1')).toBe(true);
    // 1200 expired, one pass deletes at most 500, plus the new live claim.
    expect(count(raw)).toBe(1200 - 500 + 1);
    expect(await latch.tryClaim('new-2')).toBe(true);
    expect(count(raw)).toBe(1200 - 1000 + 2);
  });

  it('does not sweep when the draw misses', async () => {
    const { db, raw } = sqliteD1();
    seedExpired(raw, 5);
    const latch = makeDedupLatch({ db, table: 'dedup', ttlSec: 60, autoSweep: { everyNClaims: 10, batch: 500 }, random: () => 0.5 });
    await latch.tryClaim('new');
    expect(count(raw)).toBe(6);
  });

  it('never deletes a live claim', async () => {
    const { db, raw } = sqliteD1();
    const latch = makeDedupLatch({ db, table: 'dedup', ttlSec: 3600, autoSweep: { everyNClaims: 1, batch: 500 }, random: () => 0 });
    await latch.tryClaim('a');
    await latch.tryClaim('b');
    expect(count(raw)).toBe(2);
    expect(await latch.tryClaim('a')).toBe(false); // still latched
  });

  it('a failing sweep never fails the claim', async () => {
    const { db } = sqliteD1();
    const flaky: D1Like = {
      prepare(sql: string) {
        if (sql.includes('DELETE')) throw new Error('boom');
        return db.prepare(sql);
      },
    };
    const latch = makeDedupLatch({ db: flaky, table: 'dedup', ttlSec: 60, autoSweep: { everyNClaims: 1 }, random: () => 0 });
    expect(await latch.tryClaim('x')).toBe(true);
  });

  it('is on by default, and can be switched off', async () => {
    const { db, raw } = sqliteD1();
    seedExpired(raw, 3);
    await makeDedupLatch({ db, table: 'dedup', ttlSec: 60, random: () => 0 }).tryClaim('on');
    expect(count(raw)).toBe(1);

    seedExpired(raw, 3);
    await makeDedupLatch({ db, table: 'dedup', ttlSec: 60, autoSweep: false, random: () => 0 }).tryClaim('off');
    expect(count(raw)).toBe(5);
  });

  it('rejects a nonsensical configuration', () => {
    const { db } = sqliteD1();
    expect(() => makeDedupLatch({ db, table: 'dedup', ttlSec: 60, autoSweep: { everyNClaims: 0 } })).toThrow();
    expect(() => makeDedupLatch({ db, table: 'dedup', ttlSec: 60, autoSweep: { batch: 0 } })).toThrow();
  });
});
