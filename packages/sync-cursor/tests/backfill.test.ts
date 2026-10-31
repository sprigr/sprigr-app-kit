/**
 * The decision 0291 backfill job against a REAL SQLite (node:sqlite): keyset
 * paging, the pending predicate and the idempotent re-check are SQL behaviour
 * a regex mock would get wrong.
 *
 * What it must guarantee:
 * - a dry run writes nothing and reports counts plus samples;
 * - an apply starts only from a completed dry run of the same spec;
 * - every read is bounded by the batch size (no whole-table statement);
 * - a step re-run from an old cursor (the platform runs steps at least once)
 *   changes nothing twice;
 * - a step stops inside its time and statement budgets, and the walk resumes
 *   from the persisted state;
 * - verify reaches zero only when every row is on the new shape.
 */
import { describe, it, expect } from 'vitest';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
// Loaded at runtime: vite strips the `node:` prefix from `sqlite` (see dedup-latch's tests).
const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): typeof import('node:sqlite') }).getBuiltinModule('node:sqlite');
import {
  runBackfillStep,
  startBackfill,
  backfillFingerprint,
  backfillVerified,
  type BackfillSpec,
  type BackfillDirective,
  type BackfillJobInput,
  type BackfillJobsBinding,
  type BackfillResult,
  type D1BatchLike,
} from '../src/index';
import type { D1PreparedStatementLike } from '../src/types';

interface Prepared extends D1PreparedStatementLike {
  _sql: string;
  _args: unknown[];
}

function sqliteD1(rows: number): { db: D1BatchLike; raw: DatabaseSyncT; sqls: string[] } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT NOT NULL, status_code INTEGER, title TEXT)`);
  const insert = raw.prepare('INSERT INTO jobs (id, status, title) VALUES (?, ?, ?)');
  for (let i = 1; i <= rows; i++) insert.run(i, i % 3 === 0 ? 'closed' : 'open', `Job ${i}`);
  const sqls: string[] = [];
  const stmt = (sql: string, args: unknown[]): Prepared => ({
    _sql: sql,
    _args: args,
    bind: (...next: unknown[]) => stmt(sql, [...args, ...next]),
    run: async () => {
      sqls.push(sql);
      const r = raw.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
    first: async <T>() => {
      sqls.push(sql);
      return (raw.prepare(sql).get(...(args as never[])) as T | undefined) ?? null;
    },
    all: async <T>() => {
      sqls.push(sql);
      return { results: raw.prepare(sql).all(...(args as never[])) as T[] };
    },
  });
  const db: D1BatchLike = {
    prepare: (sql) => stmt(sql, []),
    batch: async (statements) => {
      raw.exec('BEGIN');
      try {
        const out = statements.map((s) => {
          const p = s as Prepared;
          sqls.push(p._sql);
          return { meta: { changes: Number(raw.prepare(p._sql).run(...(p._args as never[])).changes) } };
        });
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { db, raw, sqls };
}

const spec: BackfillSpec = {
  name: 'jobs_status_code',
  version: '1',
  table: 'jobs',
  primaryKey: 'id',
  pending: 'status_code IS NULL',
  columns: ['status'],
  apply: (db, rows) =>
    rows.map((r) =>
      db.prepare('UPDATE jobs SET status_code = ? WHERE id = ? AND (status_code IS NULL)').bind(r.status === 'closed' ? 2 : 1, r.id),
    ),
};

async function params(mode: 'dry_run' | 'apply' | 'verify', extra: Record<string, unknown> = {}) {
  return { spec: spec.name, mode, fingerprint: await backfillFingerprint(spec), ...extra };
}

/** Drive a run to its terminal directive, the way the platform would: step after step, carrying state. */
async function drive(db: D1BatchLike, job: Omit<BackfillJobInput, 'step' | 'state'>, opts: { maxStatementsPerStep?: number; budgetMs?: number; now?: () => number } = {}) {
  let state = null as BackfillJobInput['state'];
  for (let step = 0; step < 1_000; step++) {
    const d: BackfillDirective = await runBackfillStep({ db, spec, job: { ...job, step, state }, ...opts });
    if (d.op !== 'continue') return { directive: d, steps: step + 1 };
    state = d.state;
  }
  throw new Error('did not finish');
}

const pendingCount = (raw: DatabaseSyncT) => Number((raw.prepare('SELECT COUNT(*) AS n FROM jobs WHERE status_code IS NULL').get() as { n: number }).n);

describe('dry run', () => {
  it('writes nothing and reports counts and samples', async () => {
    const { db, raw, sqls } = sqliteD1(2_500);
    const { directive } = await drive(db, { params: await params('dry_run') });
    expect(directive.op).toBe('complete');
    const r = (directive as { result: BackfillResult }).result;
    expect(r).toMatchObject({ mode: 'dry_run', scanned: 2_500, pending: 2_500, applied: 0 });
    expect(r.samples).toHaveLength(10);
    expect(r.samples[0]).toEqual({ id: 1, status: 'open' });
    expect(pendingCount(raw)).toBe(2_500);
    expect(sqls.some((s) => /^\s*(UPDATE|INSERT|DELETE)/i.test(s))).toBe(false);
  });

  it('every read is bounded: keyset on the primary key with a LIMIT, never a bare whole-table statement', async () => {
    const { db, sqls } = sqliteD1(1_200);
    await drive(db, { params: await params('dry_run') });
    for (const s of sqls) {
      expect(s.includes('LIMIT ?') || /WHERE .*id <= \?/.test(s)).toBe(true);
      expect(s).not.toMatch(/OFFSET/i);
    }
  });

  it('a sample row too wide to keep is counted, not cut', async () => {
    const { db, raw } = sqliteD1(3);
    raw.prepare('UPDATE jobs SET status = ? WHERE id = 2').run('x'.repeat(5_000));
    const { directive } = await drive(db, { params: await params('dry_run') });
    const r = (directive as { result: BackfillResult }).result;
    expect(r.samples.map((s) => s.id)).toEqual([1, 3]);
    expect(r.samplesOmittedForSize).toBe(1);
  });
});

describe('apply', () => {
  it('fills every pending row, then verify reports zero', async () => {
    const { db, raw } = sqliteD1(2_500);
    const { directive } = await drive(db, { params: await params('apply', { dry_run_job_id: 'job_dry' }) });
    expect((directive as { result: BackfillResult }).result).toMatchObject({ mode: 'apply', scanned: 2_500, pending: 2_500, applied: 2_500 });
    expect(pendingCount(raw)).toBe(0);
    expect(Number((raw.prepare('SELECT COUNT(*) AS n FROM jobs WHERE status_code = 2').get() as { n: number }).n)).toBe(833);

    const verify = await drive(db, { params: await params('verify') });
    const vr = (verify.directive as { result: BackfillResult }).result;
    expect(vr.pending).toBe(0);
    expect(backfillVerified(vr)).toBe(true);
  });

  it('a step re-run from an older cursor (at-least-once dispatch) changes nothing twice', async () => {
    // 1,100 statements fit one 1,000-row batch (2 reads + 1,000 writes) but not a second.
    const { db } = sqliteD1(2_500);
    const job = { params: await params('apply', { dry_run_job_id: 'job_dry' }) };
    const first = await runBackfillStep({ db, spec, job: { ...job, step: 0, state: null }, maxStatementsPerStep: 1_100 });
    expect(first.op).toBe('continue');
    // The platform lost the response and runs step 0 again from the same (null) state.
    const again = await runBackfillStep({ db, spec, job: { ...job, step: 0, state: null }, maxStatementsPerStep: 1_100 });
    expect(again.op).toBe('continue');
    if (first.op === 'continue' && again.op === 'continue') {
      expect(first.state.applied).toBe(1_000);
      expect(again.state.applied).toBe(0);
      expect(again.state.cursor).toBe(first.state.cursor);
    }
  });

  it('rows that change shape mid-run (live traffic) are skipped, not overwritten', async () => {
    const { db, raw } = sqliteD1(10);
    raw.prepare('UPDATE jobs SET status_code = 9 WHERE id = 5').run();
    const { directive } = await drive(db, { params: await params('apply', { dry_run_job_id: 'job_dry' }) });
    expect((directive as { result: BackfillResult }).result).toMatchObject({ pending: 9, applied: 9 });
    expect((raw.prepare('SELECT status_code FROM jobs WHERE id = 5').get() as { status_code: number }).status_code).toBe(9);
  });

  it('stays under the statement budget per step and resumes across steps', async () => {
    const { db, raw } = sqliteD1(1_000);
    const { directive, steps } = await drive(db, { params: await params('apply', { dry_run_job_id: 'job_dry' }) }, { maxStatementsPerStep: 120 });
    expect(directive.op).toBe('complete');
    expect(steps).toBeGreaterThan(8);
    expect(pendingCount(raw)).toBe(0);
  });

  it('with the default budgets every apply step writes something (a batch that never fits is capped, not retried forever)', async () => {
    const { db, raw } = sqliteD1(5_000);
    const job = { params: await params('apply', { dry_run_job_id: 'job_dry' }) };
    let state = null as BackfillJobInput['state'];
    const appliedPerStep: number[] = [];
    for (let step = 0; step < 50; step++) {
      const d = await runBackfillStep({ db, spec, job: { ...job, step, state } });
      if (d.op === 'complete') break;
      expect(d.op).toBe('continue');
      if (d.op !== 'continue') return;
      appliedPerStep.push(d.state.applied - (state?.applied ?? 0));
      state = d.state;
    }
    expect(pendingCount(raw)).toBe(0);
    // Step 0 may only learn the cap; every later step makes progress.
    expect(appliedPerStep.slice(1).every((n) => n > 0)).toBe(true);
  });

  it('stops at the time budget with the cursor saved', async () => {
    const { db } = sqliteD1(5_000);
    let t = 0;
    const d = await runBackfillStep({
      db, spec, job: { params: await params('dry_run'), step: 0, state: null },
      budgetMs: 1_000, targetBatchMs: 100, now: () => (t += 400), // every clock read moves 400 ms
    });
    expect(d.op).toBe('continue');
    if (d.op === 'continue') {
      expect(d.state.scanned).toBeGreaterThan(0);
      expect(d.state.scanned).toBeLessThan(5_000);
      expect(d.state.cursor).toBe(d.state.scanned);
      // Slow batches shrink the next one.
      expect(d.state.batchSize).toBeLessThan(1_000);
      expect(d.label).toMatch(/^dry_run: \d+ rows scanned/);
    }
  });

  it('a run started for an older spec version fails rather than applying different code', async () => {
    const { db } = sqliteD1(10);
    const old = { ...(await params('apply', { dry_run_job_id: 'job_dry' })), fingerprint: 'not-this-spec' };
    const d = await runBackfillStep({ db, spec, job: { params: old, step: 3, state: null } });
    expect(d).toMatchObject({ op: 'fail', retryable: false });
    expect((d as { error: string }).error).toMatch(/spec changed since this run started/);
  });

  it('an apply run with no approved dry run in its params is refused at the step too', async () => {
    const { db, raw } = sqliteD1(10);
    const d = await runBackfillStep({ db, spec, job: { params: await params('apply'), step: 0, state: null } });
    expect(d).toMatchObject({ op: 'fail' });
    expect(pendingCount(raw)).toBe(10);
  });
});

describe('startBackfill: no apply without a read dry run', () => {
  function jobs(records: Record<string, { status: string; result?: unknown }>) {
    const started: Array<{ name: string; params: unknown; idempotencyKey?: string }> = [];
    const binding: BackfillJobsBinding = {
      start: async (input) => {
        started.push(input);
        return { ok: true, existing: false, job: { job_id: `job_${started.length}` } };
      },
      get: async (id) => (records[id] ? { job_id: id, ...records[id] } : null),
    };
    return { binding, started };
  }
  const NOW = Date.parse('2026-10-23T10:00:00Z');
  const dryResult = async (over: Partial<BackfillResult> = {}): Promise<BackfillResult> => ({
    spec: spec.name, mode: 'dry_run', fingerprint: await backfillFingerprint(spec), finishedAt: '2026-10-23T09:00:00Z',
    cursor: 2500, batchSize: 1000, scanned: 2500, pending: 2500, applied: 0, batches: 3, samples: [], samplesOmittedForSize: 0, ...over,
  });

  it('starts a dry run with the spec fingerprint', async () => {
    const j = jobs({});
    expect(await startBackfill(j.binding, { jobName: 'backfill', spec, mode: 'dry_run' })).toEqual({ ok: true, jobId: 'job_1', existing: false });
    expect(j.started[0]).toEqual({ name: 'backfill', params: { spec: spec.name, mode: 'dry_run', fingerprint: await backfillFingerprint(spec) } });
  });

  it('refuses an apply with no dry run, an unfinished one, or one for another spec version', async () => {
    const j = jobs({
      job_running: { status: 'running' },
      job_old: { status: 'completed', result: await dryResult({ fingerprint: 'abc' }) },
      job_verify: { status: 'completed', result: await dryResult({ mode: 'verify' }) },
    });
    const apply = (approvedDryRunJobId?: string) => startBackfill(j.binding, { jobName: 'backfill', spec, mode: 'apply', approvedDryRunJobId, now: () => NOW });
    expect(await apply()).toMatchObject({ ok: false, error: expect.stringMatching(/run a dry run first/) });
    expect(await apply('job_running')).toMatchObject({ ok: false, error: expect.stringMatching(/not a completed dry run/) });
    expect(await apply('job_verify')).toMatchObject({ ok: false, error: expect.stringMatching(/not a completed dry run/) });
    expect(await apply('job_old')).toMatchObject({ ok: false, error: expect.stringMatching(/different spec or version/) });
    expect(await apply('job_missing')).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    expect(j.started).toEqual([]);
  });

  it('refuses a stale dry run', async () => {
    const j = jobs({ job_dry: { status: 'completed', result: await dryResult({ finishedAt: '2026-10-01T00:00:00Z' }) } });
    expect(await startBackfill(j.binding, { jobName: 'backfill', spec, mode: 'apply', approvedDryRunJobId: 'job_dry', now: () => NOW }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/too long ago/) });
  });

  it('starts one apply per approved dry run, carrying what the dry run counted', async () => {
    const j = jobs({ job_dry: { status: 'completed', result: await dryResult() } });
    const r = await startBackfill(j.binding, { jobName: 'backfill', spec, mode: 'apply', approvedDryRunJobId: 'job_dry', now: () => NOW });
    expect(r).toMatchObject({ ok: true });
    expect(j.started[0]?.params).toMatchObject({ mode: 'apply', dry_run_job_id: 'job_dry', dry_run_pending: 2500 });
    expect(j.started[0]?.idempotencyKey).toBe(`backfill:${spec.name}:${await backfillFingerprint(spec)}:apply:job_dry`);
  });

  it('refuses a spec that is not plain SQL identifiers or carries a bound parameter', async () => {
    const j = jobs({});
    expect(await startBackfill(j.binding, { jobName: 'b', spec: { ...spec, table: 'jobs; DROP TABLE x' }, mode: 'dry_run' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/not a plain SQL identifier/) });
    expect(await startBackfill(j.binding, { jobName: 'b', spec: { ...spec, pending: 'status = ?' }, mode: 'dry_run' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/must not contain/) });
  });
});
