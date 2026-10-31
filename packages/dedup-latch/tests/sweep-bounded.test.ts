/**
 * makeDedupLatch().sweep() against a REAL SQLite (node:sqlite), not the regex
 * mock (sprigr-app-kit#126). The first sweep on a table that was never swept
 * used to delete the whole expired backlog in one statement. Each statement
 * now deletes at most `batch` rows through `id IN (SELECT id ... LIMIT ?)`
 * (D1 has no `DELETE ... LIMIT`), and one call stops at `max` rows, saying
 * `more: true` so the caller knows a backlog is left.
 */
import { describe, it, expect } from 'vitest';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
// Loaded at runtime: vite strips the `node:` prefix from `sqlite`, which is not
// on its builtin list, so a static import fails to resolve under vitest.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): typeof import('node:sqlite') }).getBuiltinModule('node:sqlite');
import { makeDedupLatch } from '../src/dedup-latch';
import type { D1Like, D1PreparedStatementLike } from '../src/types';

interface Executed {
  sql: string;
  args: unknown[];
  changes: number;
}

/** The schema every adopter's migration creates (id is the primary key). */
function sqliteD1(): { db: D1Like; raw: DatabaseSyncT; executed: Executed[] } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE webhook_dedup (
    id TEXT PRIMARY KEY,
    claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL)`);
  raw.exec('CREATE INDEX idx_webhook_dedup_expires ON webhook_dedup(expires_at)');
  const executed: Executed[] = [];
  const stmt = (sql: string, args: unknown[]): D1PreparedStatementLike => ({
    bind: (...next: unknown[]) => stmt(sql, [...args, ...next]),
    run: async () => {
      const r = raw.prepare(sql).run(...(args as never[]));
      const changes = Number(r.changes);
      executed.push({ sql: sql.replace(/\s+/g, ' ').trim(), args, changes });
      return { meta: { changes } };
    },
    first: async <T>() => (raw.prepare(sql).get(...(args as never[])) as T | undefined) ?? null,
  });
  return { db: { prepare: (sql) => stmt(sql, []) }, raw, executed };
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function seed(raw: DatabaseSyncT, prefix: string, count: number, expiresAt: string): void {
  const ins = raw.prepare('INSERT INTO webhook_dedup (id, claimed_at, expires_at) VALUES (?, ?, ?)');
  raw.exec('BEGIN');
  for (let i = 0; i < count; i++) ins.run(`${prefix}-${i}`, '2026-01-01 00:00:00', expiresAt);
  raw.exec('COMMIT');
}

const rowCount = (raw: DatabaseSyncT) =>
  Number((raw.prepare('SELECT COUNT(*) AS n FROM webhook_dedup').get() as { n: number }).n);

const deletes = (executed: Executed[]) => executed.filter((e) => e.sql.startsWith('DELETE'));

describe('makeDedupLatch sweep is bounded (#126)', () => {
  it('drains a backlog larger than the cap over several calls, no statement deleting more than batch', async () => {
    const { db, raw, executed } = sqliteD1();
    seed(raw, 'old', 2500, iso(-60_000));
    seed(raw, 'live', 10, iso(3_600_000));
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });

    expect(await latch.sweep({ batch: 400, max: 1000 })).toEqual({ deleted: 1000, more: true });
    expect(rowCount(raw)).toBe(1510);
    expect(await latch.sweep({ batch: 400, max: 1000 })).toEqual({ deleted: 1000, more: true });
    expect(rowCount(raw)).toBe(510);
    expect(await latch.sweep({ batch: 400, max: 1000 })).toEqual({ deleted: 500, more: false });
    expect(rowCount(raw)).toBe(10);
    expect(await latch.sweep({ batch: 400, max: 1000 })).toEqual({ deleted: 0, more: false });

    const del = deletes(executed);
    // 400+400+200, 400+400+200, 400+100, 0
    expect(del.map((d) => d.changes)).toEqual([400, 400, 200, 400, 400, 200, 400, 100, 0]);
    for (const d of del) {
      expect(d.changes).toBeLessThanOrEqual(400);
      expect(d.sql).toBe(
        "DELETE FROM webhook_dedup WHERE id IN (SELECT id FROM webhook_dedup WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') LIMIT ?)",
      );
      expect(d.args).toHaveLength(1);
      expect(d.args[0] as number).toBeLessThanOrEqual(400);
    }
    // Every unexpired row survived all four calls.
    const live = raw.prepare("SELECT COUNT(*) AS n FROM webhook_dedup WHERE id LIKE 'live-%'").get() as { n: number };
    expect(Number(live.n)).toBe(10);
  });

  it('defaults to batches of 1000 and stops at 5000 rows per call', async () => {
    const { db, raw, executed } = sqliteD1();
    seed(raw, 'old', 6000, iso(-60_000));
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });

    expect(await latch.sweep()).toEqual({ deleted: 5000, more: true });
    expect(rowCount(raw)).toBe(1000);
    expect(await latch.sweep()).toEqual({ deleted: 1000, more: false });
    expect(rowCount(raw)).toBe(0);

    const del = deletes(executed);
    expect(del.map((d) => d.changes)).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 0]);
    for (const d of del) expect(d.args[0] as number).toBeLessThanOrEqual(1000);
  });

  it('a backlog that is an exact multiple of the cap says more: true, and the next call clears to more: false', async () => {
    const { db, raw } = sqliteD1();
    seed(raw, 'old', 300, iso(-60_000));
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.sweep({ batch: 100, max: 300 })).toEqual({ deleted: 300, more: true });
    expect(await latch.sweep({ batch: 100, max: 300 })).toEqual({ deleted: 0, more: false });
  });

  it('a max below batch caps the single statement at max', async () => {
    const { db, raw, executed } = sqliteD1();
    seed(raw, 'old', 50, iso(-60_000));
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.sweep({ batch: 1000, max: 20 })).toEqual({ deleted: 20, more: true });
    expect(deletes(executed).map((d) => d.args[0])).toEqual([20]);
  });

  it('an empty or all-live table costs one statement and deletes nothing', async () => {
    const { db, raw, executed } = sqliteD1();
    seed(raw, 'live', 5, iso(3_600_000));
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.sweep()).toEqual({ deleted: 0, more: false });
    expect(deletes(executed)).toHaveLength(1);
    expect(rowCount(raw)).toBe(5);
  });

  it('still clears a row that expired earlier the SAME UTC day (the #46 ISO comparison)', async () => {
    const { db, raw } = sqliteD1();
    seed(raw, 'just-expired', 1, iso(-1_000));
    seed(raw, 'later-today', 1, iso(60_000));
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.sweep()).toEqual({ deleted: 1, more: false });
    const ids = (raw.prepare('SELECT id FROM webhook_dedup').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['later-today-0']);
  });

  it('refuses a batch or max that is not a positive integer, before touching the table', async () => {
    const { db, raw, executed } = sqliteD1();
    seed(raw, 'old', 3, iso(-60_000));
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(latch.sweep({ batch: bad })).rejects.toThrow('dedup-latch: sweep batch must be a positive integer');
      await expect(latch.sweep({ max: bad })).rejects.toThrow('dedup-latch: sweep max must be a positive integer');
    }
    expect(executed).toHaveLength(0);
    expect(rowCount(raw)).toBe(3);
  });
});

describe('makeDedupLatch tryClaim is unchanged (must not regress)', () => {
  it('claims once, latches a repeat, keeps latching an expired row until it is swept, then re-claims', async () => {
    const { db, raw } = sqliteD1();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 60 });
    expect(await latch.tryClaim('event-1')).toBe(true);
    expect(await latch.tryClaim('event-1')).toBe(false);
    expect(await latch.tryClaim('event-2')).toBe(true);

    // A live claim survives a sweep and keeps latching.
    expect(await latch.sweep()).toEqual({ deleted: 0, more: false });
    expect(await latch.tryClaim('event-1')).toBe(false);

    // Expired but not yet swept: the primary key still latches.
    raw.prepare("UPDATE webhook_dedup SET expires_at = ? WHERE id = 'event-1'").run(iso(-1_000));
    expect(await latch.tryClaim('event-1')).toBe(false);

    expect(await latch.sweep()).toEqual({ deleted: 1, more: false });
    expect(await latch.tryClaim('event-1')).toBe(true);
    expect(await latch.tryClaim('event-2')).toBe(false);
  });

  it('writes expires_at as now + ttlSec in ISO format', async () => {
    const { db, raw } = sqliteD1();
    const before = Date.now();
    const latch = makeDedupLatch({ db, table: 'webhook_dedup', ttlSec: 90 });
    await latch.tryClaim('event-1');
    const row = raw.prepare("SELECT expires_at FROM webhook_dedup WHERE id = 'event-1'").get() as { expires_at: string };
    expect(row.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const at = Date.parse(row.expires_at);
    expect(at).toBeGreaterThanOrEqual(before + 90_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 90_000);
  });
});
