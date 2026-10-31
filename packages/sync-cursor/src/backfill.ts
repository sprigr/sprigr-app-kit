/**
 * Row backfills inside an install's own D1, run as a platform durable job
 * (sprigr-team decision 0291: schema changes are constant-time DDL, row work
 * is a durable backfill job, every breaking change is expand then contract).
 *
 * A migration file may add a column; filling it for existing rows is this
 * job's work. Three modes over one spec:
 *
 *   dry_run  walks the whole table and writes NOTHING: counts the rows still
 *            on the old shape and keeps a few samples for a person to read.
 *   apply    starts only from a completed dry run of the same spec
 *            (`startBackfill`), and writes in small batches.
 *   verify   walks again and counts what is still pending. The contract
 *            release waits until verify reports zero on every install.
 *
 * Why it is shaped like this:
 *   - Keyset paging by the primary key, so every read is bounded by the
 *     batch size and uses the primary key index. No COUNT(*) over the table
 *     and no OFFSET: an unbounded statement on a live tenant DB can hit the
 *     CPU limit and reset the database (an LSR install DB was reset that way
 *     on 2026-10-23, sprigr-team#12626).
 *   - Idempotent: a row is selected only while `pending` is true, and the
 *     spec's apply statements must re-check `pending`. The platform runs a
 *     step at least once, so a step that ran and never returned runs again
 *     from the last persisted cursor and finds those rows already done.
 *   - Resumable: the cursor and running totals are the job's `state`, which
 *     the platform persists after each step. Nothing extra is stored in D1.
 *   - Batches are timed and resized toward `targetBatchMs` (start 1,000 rows),
 *     and a step stops before its time budget or D1's statements-per-invocation
 *     limit. Each statement is short, so live traffic gets the writer between
 *     them.
 *
 * Wiring (the app declares the job and its step tool in the manifest, with
 * `max_steps` sized for the table: rows / (rows per step)):
 *
 *   // the step tool
 *   export default (args) => runBackfillStep({ db: env.DB, spec: JOBS_STATUS_BACKFILL, job: args.job });
 *
 *   // an operator or admin route
 *   await startBackfill(env.SPRIGR.jobs, { jobName: 'backfill', spec, mode: 'dry_run' });
 *   // ...a person reads the dry run's counts and samples, then:
 *   await startBackfill(env.SPRIGR.jobs, { jobName: 'backfill', spec, mode: 'apply', approvedDryRunJobId });
 */

import type { D1Like, D1PreparedStatementLike } from './types';

export type BackfillMode = 'dry_run' | 'apply' | 'verify';

export type BackfillRow = Record<string, unknown>;

/** A D1 binding that can run a batch (real D1 does). Only `apply` needs it. */
export interface D1BatchLike extends D1Like {
  batch(statements: D1PreparedStatementLike[]): Promise<Array<{ meta?: { changes?: number } }>>;
}

export interface BackfillSpec {
  /** Stable name, e.g. 'jobs_status_code'. Part of the fingerprint. */
  name: string;
  /**
   * Bump when `apply` changes. The function body cannot be fingerprinted, so
   * this is how a dry run approved for one apply cannot start another.
   */
  version: string;
  table: string;
  /** A single-column primary key (or any unique, indexed column). */
  primaryKey: string;
  /**
   * SQL boolean over the table's columns, true while a row is on the OLD
   * shape, e.g. `status_code IS NULL`. Trusted app code, never user input;
   * no bound parameters and no `;`.
   */
  pending: string;
  /** Columns each pending row carries into `apply` and into the samples. */
  columns: string[];
  /**
   * The writes for one batch of pending rows. Every statement must re-check
   * `pending` (`UPDATE t SET ... WHERE id = ? AND (<pending>)`), so running a
   * batch twice changes nothing the second time. Return [] to skip a batch.
   */
  apply?: (db: D1Like, rows: BackfillRow[]) => D1PreparedStatementLike[];
}

export interface BackfillParams {
  spec: string;
  mode: BackfillMode;
  fingerprint: string;
  /** apply only: the dry run it was approved from, and what it counted. */
  dry_run_job_id?: string;
  dry_run_pending?: number;
}

export interface BackfillState {
  cursor: string | number | null;
  batchSize: number;
  scanned: number;
  pending: number;
  applied: number;
  batches: number;
  samples: BackfillRow[];
  /** Pending rows left out of `samples` because one row's JSON was over the per-sample cap. */
  samplesOmittedForSize: number;
  /**
   * apply: the largest batch whose writes fit a fresh step, learned the first
   * time one did not. Growth stops here, so a fast table does not grow back
   * into a batch that cannot be written and waste every other step.
   */
  batchCap?: number;
}

export interface BackfillResult extends BackfillState {
  spec: string;
  mode: BackfillMode;
  fingerprint: string;
  finishedAt: string;
}

/** The step-function input the platform dispatches (`args.job`). */
export interface BackfillJobInput {
  id?: string;
  step: number;
  params: BackfillParams;
  state: BackfillState | null;
}

export type BackfillDirective =
  | { op: 'continue'; state: BackfillState; label: string }
  | { op: 'complete'; result: BackfillResult }
  | { op: 'fail'; error: string; retryable: false };

export interface RunBackfillStepOpts {
  db: D1Like | D1BatchLike;
  spec: BackfillSpec;
  job: BackfillJobInput;
  /** Wall time a step may spend before handing back. Default 20 s, under the 60 s default step timeout. */
  budgetMs?: number;
  /** Batch time to steer toward. Default 500 ms ("well under a second", decision 0291). */
  targetBatchMs?: number;
  /** Statements one step may issue. Default 900, under D1's 1,000 per invocation. */
  maxStatementsPerStep?: number;
  /** Samples kept by dry_run and verify. Default 10. */
  sampleLimit?: number;
  now?: () => number;
}

export const BACKFILL_INITIAL_BATCH = 1_000;
const MIN_BATCH = 50;
const MAX_BATCH = 5_000;
/** One sample row's JSON. A wider row is counted in samplesOmittedForSize, not cut. */
const MAX_SAMPLE_JSON = 2_048;

export async function backfillFingerprint(spec: BackfillSpec): Promise<string> {
  const material = JSON.stringify([spec.name, spec.version, spec.table, spec.primaryKey, spec.pending, spec.columns]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** Run one step of a backfill job. Never throws for a spec or param problem: that fails the job, non-retryably. */
export async function runBackfillStep(opts: RunBackfillStepOpts): Promise<BackfillDirective> {
  const { db, spec, job } = opts;
  const budgetMs = opts.budgetMs ?? 20_000;
  const targetBatchMs = opts.targetBatchMs ?? 500;
  const maxStatements = opts.maxStatementsPerStep ?? 900;
  const sampleLimit = opts.sampleLimit ?? 10;
  const now = opts.now ?? (() => Date.now());

  const problem = specProblem(spec) ?? (await paramsProblem(spec, job.params));
  if (problem) return { op: 'fail', error: problem, retryable: false };
  const mode = job.params.mode;
  if (mode === 'apply' && !('batch' in db)) {
    return { op: 'fail', error: 'apply needs a D1 binding with batch()', retryable: false };
  }

  const state: BackfillState = job.state
    ? { ...job.state, samples: [...job.state.samples] }
    : { cursor: null, batchSize: BACKFILL_INITIAL_BATCH, scanned: 0, pending: 0, applied: 0, batches: 0, samples: [], samplesOmittedForSize: 0 };

  const { table, primaryKey: pk } = spec;
  const cols = [...new Set([pk, ...spec.columns])].join(', ');
  const started = now();
  let statements = 0;
  let batchesThisStep = 0;

  while (now() - started < budgetMs) {
    // Two reads per batch; the apply statements are checked once they are built.
    if (statements + 2 > maxStatements) break;
    const batchStart = now();
    const after = state.cursor;
    const window = await db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(k) AS hi FROM (SELECT ${pk} AS k FROM ${table}${after === null ? '' : ` WHERE ${pk} > ?`} ORDER BY ${pk} LIMIT ?)`,
      )
      .bind(...(after === null ? [] : [after]), state.batchSize)
      .first<{ n: number; hi: string | number | null }>();
    statements += 1;
    const n = Number(window?.n ?? 0);
    if (n === 0 || window?.hi == null) {
      return { op: 'complete', result: { ...state, spec: spec.name, mode, fingerprint: job.params.fingerprint, finishedAt: new Date(now()).toISOString() } };
    }
    const hi = window.hi;
    const rows = (
      await db
        .prepare(
          `SELECT ${cols} FROM ${table} WHERE ${after === null ? '' : `${pk} > ? AND `}${pk} <= ? AND (${spec.pending}) ORDER BY ${pk}`,
        )
        .bind(...(after === null ? [] : [after]), hi)
        .all<BackfillRow>()
    ).results ?? [];
    statements += 1;

    if (mode === 'apply' && rows.length > 0) {
      const writes = spec.apply!(db, rows);
      if (statements + writes.length > maxStatements) {
        // The cursor is not advanced, so this window is read again. A batch too big
        // even for a fresh step shrinks first, and fails only at the smallest size.
        if (batchesThisStep === 0) {
          if (state.batchSize <= MIN_BATCH) {
            return { op: 'fail', error: `a ${state.batchSize}-row batch needs ${writes.length} statements, over the ${maxStatements} a step may issue; write fewer statements per row`, retryable: false };
          }
          state.batchSize = Math.max(MIN_BATCH, Math.floor(state.batchSize / 2));
          state.batchCap = state.batchSize;
        }
        break;
      }
      if (writes.length > 0) {
        const results = await (db as D1BatchLike).batch(writes);
        statements += writes.length;
        state.applied += results.reduce((sum, r) => sum + Number(r?.meta?.changes ?? 0), 0);
      }
    }
    if (mode !== 'apply') keepSamples(state, rows, sampleLimit);

    state.pending += rows.length;
    state.scanned += n;
    state.cursor = hi;
    state.batches += 1;
    batchesThisStep += 1;
    state.batchSize = Math.min(resized(state.batchSize, now() - batchStart, targetBatchMs), state.batchCap ?? MAX_BATCH);
  }

  return { op: 'continue', state, label: progressLabel(mode, state) };
}

export interface BackfillJobsBinding {
  start(input: { name: string; params: BackfillParams; idempotencyKey?: string }): Promise<{ ok: boolean; existing?: boolean; job: { job_id: string } }>;
  get(jobId: string): Promise<{ job_id: string; name?: string; status: string; result?: unknown } | null>;
}

export interface StartBackfillOpts {
  /** The manifest `jobs[].name` whose step tool calls runBackfillStep. */
  jobName: string;
  spec: BackfillSpec;
  mode: BackfillMode;
  /** apply only: a completed dry run of this exact spec. */
  approvedDryRunJobId?: string;
  /** apply only: refuse a dry run older than this. Default 7 days. */
  maxDryRunAgeMs?: number;
  /** dry_run and verify: pass one to make a repeat start return the same run. */
  idempotencyKey?: string;
  now?: () => number;
}

export type StartBackfillResult =
  | { ok: true; jobId: string; existing: boolean }
  | { ok: false; error: string };

/**
 * Start a backfill run. An apply is refused unless `approvedDryRunJobId`
 * names a completed dry run of the same spec (same fingerprint), recent
 * enough. One apply per approved dry run: a second start returns the first.
 */
export async function startBackfill(jobs: BackfillJobsBinding, opts: StartBackfillOpts): Promise<StartBackfillResult> {
  const problem = specProblem(opts.spec);
  if (problem) return { ok: false, error: problem };
  const fingerprint = await backfillFingerprint(opts.spec);
  const params: BackfillParams = { spec: opts.spec.name, mode: opts.mode, fingerprint };
  let idempotencyKey = opts.idempotencyKey;

  if (opts.mode === 'apply') {
    if (!opts.spec.apply) return { ok: false, error: `spec ${opts.spec.name} has no apply` };
    if (!opts.approvedDryRunJobId) return { ok: false, error: 'apply needs approvedDryRunJobId: run a dry run first and have its counts and samples read' };
    const dry = await jobs.get(opts.approvedDryRunJobId);
    const result = dry?.result as Partial<BackfillResult> | undefined;
    if (!dry || dry.status !== 'completed' || result?.mode !== 'dry_run') {
      return { ok: false, error: `job ${opts.approvedDryRunJobId} is not a completed dry run (status ${dry?.status ?? 'not found'})` };
    }
    if (result.fingerprint !== fingerprint) {
      return { ok: false, error: `dry run ${opts.approvedDryRunJobId} was for a different spec or version (fingerprint ${result.fingerprint}, now ${fingerprint}); run a new dry run` };
    }
    const age = (opts.now ?? Date.now)() - Date.parse(result.finishedAt ?? '');
    if (!(age <= (opts.maxDryRunAgeMs ?? 7 * 24 * 3600_000))) {
      return { ok: false, error: `dry run ${opts.approvedDryRunJobId} finished at ${result.finishedAt}, too long ago; run a new one` };
    }
    params.dry_run_job_id = opts.approvedDryRunJobId;
    params.dry_run_pending = result.pending;
    idempotencyKey = `backfill:${opts.spec.name}:${fingerprint}:apply:${opts.approvedDryRunJobId}`;
  }

  const started = await jobs.start({ name: opts.jobName, params, ...(idempotencyKey ? { idempotencyKey } : {}) });
  if (!started.ok) return { ok: false, error: 'jobs.start refused the run' };
  return { ok: true, jobId: started.job.job_id, existing: Boolean(started.existing) };
}

/** A verify run's verdict: the contract release may ship only when every install reports clean. */
export function backfillVerified(result: BackfillResult): boolean {
  return result.mode === 'verify' && result.pending === 0;
}

const IDENT_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function specProblem(spec: BackfillSpec): string | null {
  for (const [what, name] of [['table', spec.table], ['primaryKey', spec.primaryKey], ...spec.columns.map((c) => ['column', c])] as Array<[string, string]>) {
    if (!IDENT_RX.test(name)) return `backfill ${spec.name}: ${what} "${name}" is not a plain SQL identifier`;
  }
  if (!spec.pending.trim()) return `backfill ${spec.name}: pending is empty`;
  if (/[?;]/.test(spec.pending)) return `backfill ${spec.name}: pending must not contain "?" or ";"`;
  if (!spec.version) return `backfill ${spec.name}: version is required`;
  return null;
}

async function paramsProblem(spec: BackfillSpec, params: BackfillParams | undefined): Promise<string | null> {
  if (!params || !['dry_run', 'apply', 'verify'].includes(params.mode)) return `backfill ${spec.name}: params.mode must be dry_run, apply or verify`;
  if (params.spec !== spec.name) return `backfill: this run is for ${params.spec}, not ${spec.name}`;
  const fingerprint = await backfillFingerprint(spec);
  if (params.fingerprint !== fingerprint) {
    return `backfill ${spec.name}: the spec changed since this run started (fingerprint ${params.fingerprint}, now ${fingerprint}); start a new dry run`;
  }
  if (params.mode === 'apply' && !spec.apply) return `backfill ${spec.name}: apply run but the spec has no apply`;
  if (params.mode === 'apply' && !params.dry_run_job_id) return `backfill ${spec.name}: apply run without an approved dry run; start it with startBackfill`;
  return null;
}

function keepSamples(state: BackfillState, rows: BackfillRow[], limit: number): void {
  for (const row of rows) {
    if (state.samples.length >= limit) return;
    if (JSON.stringify(row).length > MAX_SAMPLE_JSON) state.samplesOmittedForSize += 1;
    else state.samples.push(row);
  }
}

function resized(size: number, tookMs: number, targetMs: number): number {
  if (tookMs > targetMs) return Math.max(MIN_BATCH, Math.floor(size / 2));
  if (tookMs < targetMs / 4) return Math.min(MAX_BATCH, size * 2);
  return size;
}

function progressLabel(mode: BackfillMode, s: BackfillState): string {
  const done = mode === 'apply' ? `${s.applied} written` : `${s.pending} pending`;
  return `${mode}: ${s.scanned} rows scanned, ${done}, cursor ${String(s.cursor)}`.slice(0, 256);
}
