import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { D1Like } from '../src/index';
import { pruneAuditTable } from '../src/audit-retention';

// Through createRequire: vite strips the `node:` prefix while resolving and
// then looks for a package literally named "sqlite".
const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const RETENTION = 30 * DAY;

/** A real SQLite database behind D1Like, recording every statement it runs. */
function sqliteD1(schema: string): D1Like & { raw: DatabaseSync; sql: string[] } {
  const raw = new Database(':memory:');
  raw.exec(schema);
  const sql: string[] = [];
  return {
    raw,
    sql,
    prepare(text: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params = args;
          return stmt;
        },
        async run() {
          sql.push(text);
          const info = raw.prepare(text).run(...(params as never[]));
          return { meta: { changes: Number(info.changes) } };
        },
        async first<T>() {
          return (raw.prepare(text).get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: raw.prepare(text).all(...(params as never[])) as T[] };
        },
      };
      return stmt;
    },
  };
}

/** The shape most app audit tables use: epoch-ms `ts`, AUTOINCREMENT id. */
const EPOCH_SCHEMA = `CREATE TABLE app_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL);`;

/** google-workspace's shape: datetime('now') text, only a (kind, created_at) index. */
const DATETIME_SCHEMA = `CREATE TABLE gws_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX gws_audit_kind ON gws_audit(kind, created_at);`;

function insertEpoch(db: { raw: DatabaseSync }, ageDays: number, count = 1): void {
  const stmt = db.raw.prepare('INSERT INTO app_audit (ts, tool) VALUES (?, ?)');
  for (let i = 0; i < count; i++) stmt.run(NOW - ageDays * DAY, 't');
}

function count(db: { raw: DatabaseSync }, table: string): number {
  return Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

const epochOpts = { table: 'app_audit', timeColumn: 'ts', timeFormat: 'epoch_ms', retentionMs: RETENTION, now: NOW } as const;

describe('pruneAuditTable', () => {
  it('deletes rows older than retention and keeps newer ones (epoch_ms)', async () => {
    const db = sqliteD1(EPOCH_SCHEMA);
    insertEpoch(db, 45, 3);
    insertEpoch(db, 31, 2);
    insertEpoch(db, 29, 4);
    insertEpoch(db, 0, 1);

    expect(await pruneAuditTable(db, epochOpts)).toEqual({ deleted: 5, more: false });
    expect(count(db, 'app_audit')).toBe(5);
    const oldest = db.raw.prepare('SELECT MIN(ts) AS ts FROM app_audit').get() as { ts: number };
    expect(oldest.ts).toBe(NOW - 29 * DAY);
  });

  it("compares datetime('now') text against a cutoff in the same format", async () => {
    const db = sqliteD1(DATETIME_SCHEMA);
    db.raw.exec(`
      INSERT INTO gws_audit (kind, created_at) VALUES ('schedule', '2026-09-01 00:00:00');
      INSERT INTO gws_audit (kind, created_at) VALUES ('webhook',  '2026-09-27 11:59:59');
      INSERT INTO gws_audit (kind, created_at) VALUES ('schedule', '2026-09-27 12:00:01');
      INSERT INTO gws_audit (kind, created_at) VALUES ('webhook',  '2026-10-26 00:00:00');
    `);

    const res = await pruneAuditTable(db, {
      table: 'gws_audit',
      timeColumn: 'created_at',
      timeFormat: 'sqlite_datetime',
      retentionMs: RETENTION,
      now: NOW,
    });

    // The cutoff is 2026-09-27 12:00:00: one second either side decides it.
    expect(res).toEqual({ deleted: 2, more: false });
    const left = db.raw.prepare('SELECT created_at FROM gws_audit ORDER BY id').all() as Array<{ created_at: string }>;
    expect(left.map((r) => r.created_at)).toEqual(['2026-09-27 12:00:01', '2026-10-26 00:00:00']);
  });

  it('is bounded: batch rows per statement, max rows per call, and the next call carries on', async () => {
    const db = sqliteD1(EPOCH_SCHEMA);
    insertEpoch(db, 60, 5200);
    insertEpoch(db, 1, 10);

    const first = await pruneAuditTable(db, epochOpts);
    expect(first).toEqual({ deleted: 5000, more: true });
    expect(db.sql).toHaveLength(5);
    expect(db.sql.every((s) => /LIMIT \?/.test(s))).toBe(true);
    expect(count(db, 'app_audit')).toBe(210);

    db.sql.length = 0;
    const second = await pruneAuditTable(db, epochOpts);
    expect(second).toEqual({ deleted: 200, more: false });
    expect(db.sql).toHaveLength(1);
    expect(count(db, 'app_audit')).toBe(10);
  });

  it('honours custom batch and max, and a max that is not a multiple of batch', async () => {
    const db = sqliteD1(EPOCH_SCHEMA);
    insertEpoch(db, 60, 25);

    const res = await pruneAuditTable(db, { ...epochOpts, batch: 10, max: 15 });
    expect(res).toEqual({ deleted: 15, more: true });
    expect(db.sql).toHaveLength(2);
    expect(count(db, 'app_audit')).toBe(10);
  });

  it('stops after one statement when nothing is past retention', async () => {
    const db = sqliteD1(EPOCH_SCHEMA);
    insertEpoch(db, 2, 50);

    expect(await pruneAuditTable(db, epochOpts)).toEqual({ deleted: 0, more: false });
    expect(db.sql).toHaveLength(1);
    expect(count(db, 'app_audit')).toBe(50);
  });

  it('only looks at the lowest ids, so a young row ahead of old ones ends the call', async () => {
    // A backdated or clock-skewed row with a low id: the window stops at it
    // rather than scanning the table, and the old rows behind it wait until
    // it ages out. Bounded reads are the point; this is the price.
    const db = sqliteD1(EPOCH_SCHEMA);
    insertEpoch(db, 1, 1);
    insertEpoch(db, 60, 5);

    expect(await pruneAuditTable(db, { ...epochOpts, batch: 1 })).toEqual({ deleted: 0, more: false });
    expect(count(db, 'app_audit')).toBe(6);
  });

  it('deletes old rows that share a window with young ones', async () => {
    const db = sqliteD1(EPOCH_SCHEMA);
    insertEpoch(db, 1, 1);
    insertEpoch(db, 60, 5);

    expect(await pruneAuditTable(db, epochOpts)).toEqual({ deleted: 5, more: false });
    expect(count(db, 'app_audit')).toBe(1);
  });

  it("walks rowid when the table declares no id column", async () => {
    const db = sqliteD1(`CREATE TABLE plain_audit (ts INTEGER NOT NULL, tool TEXT);`);
    const stmt = db.raw.prepare('INSERT INTO plain_audit (ts, tool) VALUES (?, ?)');
    for (let i = 0; i < 3; i++) stmt.run(NOW - 40 * DAY, 't');
    stmt.run(NOW, 't');

    const res = await pruneAuditTable(db, { ...epochOpts, table: 'plain_audit', idColumn: 'rowid' });
    expect(res).toEqual({ deleted: 3, more: false });
    expect(count(db, 'plain_audit')).toBe(1);
  });

  it('defaults now to Date.now()', async () => {
    const db = sqliteD1(EPOCH_SCHEMA);
    const stmt = db.raw.prepare('INSERT INTO app_audit (ts, tool) VALUES (?, ?)');
    stmt.run(Date.now() - 40 * DAY, 't');
    stmt.run(Date.now(), 't');

    const res = await pruneAuditTable(db, { table: 'app_audit', timeColumn: 'ts', timeFormat: 'epoch_ms', retentionMs: RETENTION });
    expect(res).toEqual({ deleted: 1, more: false });
  });

  it('rejects when D1 fails, so the caller decides how a failed sweep is reported', async () => {
    const failing: D1Like = {
      prepare() {
        throw new Error('D1_ERROR: no such table: app_audit');
      },
    };
    await expect(pruneAuditTable(failing, epochOpts)).rejects.toThrow('no such table');
  });

  it.each([
    ['table', { table: 'app_audit; DROP TABLE x' }],
    ['timeColumn', { timeColumn: 'ts--' }],
    ['idColumn', { idColumn: '1id' }],
  ])('refuses a %s that is not a plain identifier, before touching D1', async (name, bad) => {
    const db = sqliteD1(EPOCH_SCHEMA);
    await expect(pruneAuditTable(db, { ...epochOpts, ...bad })).rejects.toThrow(`${name} must be a plain SQL identifier`);
    expect(db.sql).toHaveLength(0);
  });

  it.each([
    ['retentionMs', { retentionMs: 0 }],
    ['retentionMs', { retentionMs: Number.NaN }],
    ['batch', { batch: 0 }],
    ['batch', { batch: 1.5 }],
    ['max', { max: -1 }],
  ])('refuses a bad %s', async (name, bad) => {
    const db = sqliteD1(EPOCH_SCHEMA);
    await expect(pruneAuditTable(db, { ...epochOpts, ...bad })).rejects.toThrow(name);
    expect(db.sql).toHaveLength(0);
  });

  it('refuses an unknown timeFormat', async () => {
    const db = sqliteD1(EPOCH_SCHEMA);
    await expect(
      pruneAuditTable(db, { ...epochOpts, timeFormat: 'iso' as unknown as 'epoch_ms' }),
    ).rejects.toThrow('timeFormat');
  });
});
