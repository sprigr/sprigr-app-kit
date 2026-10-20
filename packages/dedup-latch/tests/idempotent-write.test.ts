/**
 * makeIdempotentWrite against a REAL SQLite (node:sqlite), not a regex mock:
 * the claim's atomicity (`ON CONFLICT DO NOTHING` + changes), the state
 * transitions and the ISO-vs-datetime('now') comparison are exactly what a
 * mock would get wrong (the dedup-latch sweep bug of 2026-09-03 hid there).
 *
 * The guarantee under test (sprigr-team decision 0260): a write keyed by the
 * platform's write key runs AT MOST ONCE per key within the TTL; a concurrent
 * duplicate is refused, never run.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
// Loaded at runtime: vite strips the `node:` prefix from `sqlite`, which is not
// on its builtin list, so a static import fails to resolve under vitest.
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): typeof import('node:sqlite') }).getBuiltinModule('node:sqlite');
import { makeIdempotentWrite, idempotentToolResult } from '../src/idempotent-write';
import type { D1Like, D1PreparedStatementLike } from '../src/types';

function sqliteD1(): { db: D1Like; raw: DatabaseSyncT } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE app_write_keys (
    id TEXT PRIMARY KEY, state TEXT NOT NULL, result TEXT,
    claimed_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
  const stmt = (sql: string, args: unknown[]): D1PreparedStatementLike => ({
    bind: (...next: unknown[]) => stmt(sql, [...args, ...next]),
    run: async () => {
      const r = raw.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
    first: async <T>() => (raw.prepare(sql).get(...(args as never[])) as T | undefined) ?? null,
  });
  return { db: { prepare: (sql) => stmt(sql, []) }, raw };
}

afterEach(() => vi.useRealTimers());

describe('makeIdempotentWrite', () => {
  it('runs the write directly when there is no key (older platform, tool not opted in)', async () => {
    const { db } = sqliteD1();
    const fn = vi.fn(async () => ({ id: 1 }));
    const w = makeIdempotentWrite({ db, table: 'app_write_keys' });
    expect(await w.run(undefined, fn)).toEqual({ status: 'ran', result: { id: 1 } });
    expect(await w.run('', fn)).toEqual({ status: 'ran', result: { id: 1 } });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs once, then replays the stored result for a repeat without running the write again', async () => {
    const { db } = sqliteD1();
    const fn = vi.fn(async () => ({ note_id: 42 }));
    const w = makeIdempotentWrite({ db, table: 'app_write_keys' });
    expect(await w.run('w1:k', fn)).toEqual({ status: 'ran', result: { note_id: 42 } });
    expect(await w.run('w1:k', fn)).toEqual({ status: 'replayed', result: { note_id: 42 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refuses a CONCURRENT duplicate as in_progress and never runs it', async () => {
    const { db } = sqliteD1();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fn = vi.fn(async () => { await gate; return { ok: 1 }; });
    const w = makeIdempotentWrite({ db, table: 'app_write_keys' });
    const first = w.run('w1:k', fn);
    await new Promise((r) => setTimeout(r, 5));
    expect(await w.run('w1:k', fn)).toEqual({ status: 'in_progress' });
    release();
    expect(await first).toEqual({ status: 'ran', result: { ok: 1 } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the write throws, so a real retry runs', async () => {
    const { db } = sqliteD1();
    const w = makeIdempotentWrite({ db, table: 'app_write_keys' });
    await expect(w.run('w1:k', async () => { throw new Error('upstream 500'); })).rejects.toThrow('upstream 500');
    const fn = vi.fn(async () => 'second');
    expect(await w.run('w1:k', fn)).toEqual({ status: 'ran', result: 'second' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throw that may have landed (releaseOnError false) answers outcome_unknown, then the next attempt runs', async () => {
    const { db } = sqliteD1();
    class MayHaveLanded extends Error {}
    const w = makeIdempotentWrite({ db, table: 'app_write_keys', releaseOnError: (err) => !(err instanceof MayHaveLanded) });
    await expect(w.run('w1:k', async () => { throw new MayHaveLanded('timeout after send'); })).rejects.toThrow('timeout after send');
    const fn = vi.fn(async () => 'retried');
    expect(await w.run('w1:k', fn)).toEqual({ status: 'outcome_unknown' });
    expect(fn).not.toHaveBeenCalled();
    expect(await w.run('w1:k', fn)).toEqual({ status: 'ran', result: 'retried' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a claim left running past staleRunningSec answers outcome_unknown ONCE, then the next attempt runs', async () => {
    const { db, raw } = sqliteD1();
    // The first invocation died mid-write: a running claim, 10 minutes old.
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    raw.prepare(`INSERT INTO app_write_keys VALUES ('w1:k', 'running', NULL, ?, ?)`).run(old, new Date(Date.now() + 3600_000).toISOString());
    const fn = vi.fn(async () => 'retried');
    const w = makeIdempotentWrite({ db, table: 'app_write_keys', staleRunningSec: 120 });
    expect(await w.run('w1:k', fn)).toEqual({ status: 'outcome_unknown' });
    expect(fn).not.toHaveBeenCalled();
    expect(await w.run('w1:k', fn)).toEqual({ status: 'ran', result: 'retried' });
    expect(await w.run('w1:k', fn)).toEqual({ status: 'replayed', result: 'retried' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a fresh running claim is NOT treated as stale', async () => {
    const { db, raw } = sqliteD1();
    raw.prepare(`INSERT INTO app_write_keys VALUES ('w1:k', 'running', NULL, ?, ?)`).run(new Date(Date.now() - 30_000).toISOString(), new Date(Date.now() + 3600_000).toISOString());
    const fn = vi.fn(async () => 'x');
    const w = makeIdempotentWrite({ db, table: 'app_write_keys', staleRunningSec: 120 });
    expect(await w.run('w1:k', fn)).toEqual({ status: 'in_progress' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('stores a marker, not a cut value, for a result over maxResultBytes', async () => {
    const { db } = sqliteD1();
    const big = { blob: 'x'.repeat(200) };
    const w = makeIdempotentWrite({ db, table: 'app_write_keys', maxResultBytes: 100 });
    expect(await w.run('w1:k', async () => big)).toEqual({ status: 'ran', result: big });
    const replay = await w.run('w1:k', async () => big);
    expect(replay).toMatchObject({ status: 'replayed', result: { result_not_stored: true } });
    expect((replay as { result: { bytes: number } }).result.bytes).toBe(JSON.stringify(big).length);
  });

  it('an expired claim no longer guards: the write runs again', async () => {
    const { db, raw } = sqliteD1();
    raw.prepare(`INSERT INTO app_write_keys VALUES ('w1:k', 'done', '"old"', ?, ?)`).run(new Date(Date.now() - 2 * 86400_000).toISOString(), new Date(Date.now() - 86400_000).toISOString());
    const fn = vi.fn(async () => 'new');
    const w = makeIdempotentWrite({ db, table: 'app_write_keys' });
    expect(await w.run('w1:k', fn)).toEqual({ status: 'ran', result: 'new' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('sweep deletes only expired claims, comparing ISO timestamps correctly on the same UTC day', async () => {
    const { db, raw } = sqliteD1();
    const soon = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    raw.prepare(`INSERT INTO app_write_keys VALUES ('live', 'done', '1', ?, ?)`).run(past, soon);
    raw.prepare(`INSERT INTO app_write_keys VALUES ('dead', 'done', '1', ?, ?)`).run(past, past);
    const w = makeIdempotentWrite({ db, table: 'app_write_keys' });
    expect(await w.sweep()).toEqual({ deleted: 1 });
    expect(raw.prepare(`SELECT id FROM app_write_keys`).all().map((r) => (r as { id: string }).id)).toEqual(['live']);
  });

  it('rejects a table name that is not a plain identifier', () => {
    const { db } = sqliteD1();
    expect(() => makeIdempotentWrite({ db, table: 'x; DROP TABLE y' })).toThrow(/plain SQL identifier/);
  });
});

describe('idempotentToolResult', () => {
  it('returns the result for ran and replayed, and a plain refusal otherwise', () => {
    expect(idempotentToolResult({ status: 'ran', result: { a: 1 } })).toEqual({ a: 1 });
    expect(idempotentToolResult({ status: 'replayed', result: { a: 1 } })).toEqual({ a: 1 });
    expect(idempotentToolResult({ status: 'in_progress' })).toMatchObject({ ok: false, error: expect.stringMatching(/^write_in_progress:/), hint: expect.stringMatching(/Do not resend/) });
    expect(idempotentToolResult({ status: 'outcome_unknown' })).toMatchObject({ ok: false, error: expect.stringMatching(/^write_outcome_unknown:/), hint: expect.stringMatching(/Read back first.*an identical retry will run the write again/) });
  });
});
